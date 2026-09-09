// 本文件：交互式 REPL 界面——整个应用的主屏，把代理循环的事件流接到 React 状态与各组件上。
import { useCallback, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import type React from 'react'
import type { Settings } from '../utils/config.js'
import type { Message } from '../types/message.js'
import type { Tool, ToolContext } from '../Tool.js'
import type { PermissionContext } from '../types/permissions.js'
import { query, type CanUseTool, type Terminal } from '../query.js'
import { getAllTools } from '../tools.js'
import { PRODUCT_NAME, VERSION } from '../constants/product.js'
import { buildSessionContext, expandUserMentions } from '../context.js'
import { getSystemPrompt } from '../constants/prompts.js'
import { Markdown } from '../components/Markdown.js'
import { ToolCard, type ToolCardProps } from '../components/ToolCard.js'
import { PermissionModal, type PermissionRequest } from '../components/PermissionModal.js'
import { Spinner } from '../components/Spinner.js'
import { PromptInput } from '../components/PromptInput.js'

/**
 * One entry in the visible transcript. This is NOT the same thing as a
 * Message: the transcript holds UI concerns (a tool card with a diff, a
 * status line) and the message list holds API concerns. Keeping them separate
 * is what lets us render a rich card while sending the model plain text.
 * 可见转录中的一条记录。它不等于 Message：转录关心 UI（带 diff 的工具卡片、状态行），
 * 消息列表关心 API。两者分离，才能一边渲染富卡片、一边只给模型发纯文本。
 */
type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; card: ToolCardProps }
  | { kind: 'notice'; text: string }

export type REPLProps = { settings: Settings; permissionContext: PermissionContext }

// 本组件：REPL 主屏，持有会话状态、转录列表、授权弹窗与输入框。
export function REPL({ settings, permissionContext }: REPLProps): React.ReactElement {
  const { exit } = useApp()
  const { stdout } = useStdout()

  const [entries, setEntries] = useState<Entry[]>([])
  /**
   * Streaming text lives in its OWN state, not appended to `entries`.
   * Every token would otherwise clone the whole transcript array — this is the
   * single most important performance decision in the file.
   * 流式文本放在独立 state，不追加进 `entries`：否则每个 token 都要克隆整个转录数组。
   * 这是本文件最关键的性能决策。
   */
  const [streamingText, setStreamingText] = useState('')
  const [busy, setBusy] = useState(false)
  const [permission, setPermission] = useState<PermissionRequest | undefined>()

  // The loop reads refs (synchronous); React reads state (batched).
  // 循环读 ref（同步）；React 读 state（批量）。
  const messagesRef = useRef<Message[]>([])
  const abortRef = useRef<AbortController | undefined>(undefined)
  const toolsRef = useLazyRef<Tool[]>(getAllTools)
  const sessionRef = useRef<Omit<ToolContext, 'abortController'>>({
    cwd: process.cwd(),
    readFileState: new Map(),
    sessionAllow: new Set(),
    permissions: permissionContext,
  })
  // Built once: git status and MINI.md are session-scoped, and rebuilding them
  // every turn would break the provider's prompt cache for no real benefit.
  // 只构建一次：git 状态与 MINI.md 属于会话级信息，逐回合重建只会白白打断服务商的提示词缓存。
  //
  // It has to go through useLazyRef to actually be built once — see the note there.
  // 必须经由 useLazyRef 才真的只构建一次——原因见该函数处的说明。
  const systemPromptRef = useLazyRef(() =>
    getSystemPrompt(toolsRef.current, buildSessionContext(process.cwd())),
  )

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (busy) abortRef.current?.abort('interrupt')
      else exit()
    }
  })

  /**
   * Bridges the async loop to the React modal.
   * 把异步循环桥接到 React 弹窗上。
   */
  const canUseTool: CanUseTool = useCallback(
    ({ tool, message }) =>
      new Promise<boolean>(resolve => {
        setPermission({
          message,
          toolName: tool.name,
          resolve: answer => {
            setPermission(undefined)
            if (answer === 'always') sessionRef.current.sessionAllow.add(tool.name)
            resolve(answer !== 'no')
          },
        })
      }),
    [],
  )

  const submit = useCallback(
    async (text: string) => {
      if (text === '/exit' || text === '/quit') {
        exit()
        return
      }
      if (text === '/clear') {
        messagesRef.current = []
        setEntries([])
        return
      }

      setEntries(previous => [...previous, { kind: 'user', text }])
      // @path mentions are expanded for the MODEL only; the transcript keeps
      // showing what the user actually typed.
      // @path 提及只为模型展开；转录里仍显示用户实际输入的文本。
      messagesRef.current.push({
        role: 'user',
        content: expandUserMentions(text, sessionRef.current.cwd),
      })

      const abortController = new AbortController()
      abortRef.current = abortController
      setBusy(true)

      try {
        const terminal = await drive({
          messages: messagesRef.current,
          settings,
          tools: toolsRef.current,
          toolContext: { ...sessionRef.current, abortController },
          systemPrompt: systemPromptRef.current,
          canUseTool,
          setEntries,
          setStreamingText,
        })
        if (terminal.reason !== 'completed') {
          setEntries(previous => [
            ...previous,
            { kind: 'notice', text: describeTerminal(terminal) },
          ])
        }
      } finally {
        setBusy(false)
        setStreamingText('')
        abortRef.current = undefined
      }
    },
    [canUseTool, exit, settings],
  )

  const width = stdout?.columns ?? 80

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text dimColor>
          {PRODUCT_NAME} v{VERSION} · {settings.model} · {sessionRef.current.cwd} ·{' '}
        </Text>
        <Text color={modeColour(permissionContext.mode)} bold={permissionContext.mode !== 'default'}>
          {permissionContext.mode}
        </Text>
      </Box>

      {entries.map((entry, index) => (
        <EntryView key={index} entry={entry} width={width} />
      ))}

      {streamingText ? (
        <Box marginTop={1}>
          <Markdown>{streamingText}</Markdown>
        </Box>
      ) : null}

      {permission ? <PermissionModal request={permission} /> : null}

      {busy && !permission ? <Spinner label="thinking" /> : null}

      {!busy && !permission ? <PromptInput onSubmit={submit} /> : null}
    </Box>
  )
}

/**
 * Loud colour for a mode that has removed a guard rail.
 * 护栏被拿掉的模式要用显眼的颜色。
 */
// 本函数：把权限模式映射成顶栏颜色，越危险越显眼。
function modeColour(mode: string): string {
  if (mode === 'bypassPermissions') return 'red'
  if (mode === 'plan') return 'cyan'
  if (mode === 'acceptEdits') return 'yellow'
  return 'gray'
}

// 本组件：按转录记录的类型分派到相应渲染方式。
function EntryView({ entry, width }: { entry: Entry; width: number }): React.ReactElement {
  switch (entry.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color="blue" bold>
            {'> '}
          </Text>
          <Text>{entry.text}</Text>
        </Box>
      )
    case 'assistant':
      return (
        <Box marginTop={1} width={width}>
          <Markdown>{entry.text}</Markdown>
        </Box>
      )
    case 'tool':
      return <ToolCard {...entry.card} />
    case 'notice':
      return (
        <Box marginTop={1}>
          <Text color="yellow">{entry.text}</Text>
        </Box>
      )
  }
}

// 本函数：把非正常结束的回合终态翻译成一行人类可读提示。
function describeTerminal(terminal: Terminal): string {
  switch (terminal.reason) {
    case 'aborted':
      return '[interrupted]'
    case 'max_turns':
      return `[stopped after ${terminal.turns} turns]`
    case 'model_error':
      return `[model error: ${terminal.error}]`
    default:
      return ''
  }
}

// 本函数：惰性 ref——初值只在首次渲染时计算一次，避免每次渲染重复执行昂贵的构建。
/**
 * A ref whose initial value is computed once, on first render.
 * 初值只在首次渲染时计算一次的 ref。
 *
 * `useRef(expensive())` is a trap: the argument is evaluated on EVERY render
 * and the result thrown away after the first. Harmless for a literal, ruinous
 * when the expression shells out to git or walks the filesystem — every
 * streamed token re-renders this screen, so that cost lands on every token.
 * `useRef(expensive())` 是个陷阱：参数每次渲染都会求值，首次之后结果即被丢弃。
 * 对字面量无害，但当表达式会 fork git 子进程或遍历文件系统时就是灾难——
 * 每个流式 token 都会重渲染本屏，这份开销便摊到了每个 token 上。
 */
function useLazyRef<T>(make: () => T): React.MutableRefObject<T> {
  const ref = useRef<T | undefined>(undefined)
  if (ref.current === undefined) ref.current = make()
  return ref as React.MutableRefObject<T>
}

type DriveParams = {
  messages: Message[]
  settings: Settings
  tools: Tool[]
  toolContext: ToolContext
  systemPrompt?: string
  canUseTool: CanUseTool
  setEntries: React.Dispatch<React.SetStateAction<Entry[]>>
  setStreamingText: React.Dispatch<React.SetStateAction<string>>
}

// 本函数：驱动 query 生成器，把事件分发成 React 状态更新，并返回回合终态。
/**
 * Demultiplex the loop's events into React state.
 * 把循环事件解复用成 React 状态。
 *
 * The subtle part is the handover at `assistant_message`: we append the final
 * text to `entries` and clear `streamingText` in the SAME React batch, so the
 * swap from live text to settled message never flickers.
 * 微妙之处在 `assistant_message` 的交接：在同一个 React 批次里既追加最终文本到 `entries`、
 * 又清空 `streamingText`，所以从流式文本切到定稿消息不会闪烁。
 */
async function drive(params: DriveParams): Promise<Terminal> {
  const { setEntries, setStreamingText, ...queryParams } = params
  const iterator = query(queryParams)
  const toolsByName = new Map(params.tools.map(tool => [tool.name, tool]))

  while (true) {
    const step = await iterator.next()
    if (step.done) return step.value
    const event = step.value

    switch (event.type) {
      case 'text_delta':
        setStreamingText(previous => previous + event.text)
        break

      case 'assistant_message': {
        const text = event.message.role === 'assistant' ? event.message.content : ''
        setStreamingText('')
        if (text.trim()) setEntries(previous => [...previous, { kind: 'assistant', text }])
        break
      }

      case 'tool_start': {
        const tool = toolsByName.get(event.call.name)
        const title = renderTitle(tool, event.call.name, event.call.arguments)
        setEntries(previous => [
          ...previous,
          { kind: 'tool', id: event.call.id, card: { title, status: 'running' } },
        ])
        break
      }

      case 'tool_end': {
        const tool = toolsByName.get(event.call.name)
        setEntries(previous =>
          previous.map(entry =>
            entry.kind === 'tool' && entry.id === event.call.id
              ? { ...entry, card: finishCard(entry.card, event, tool) }
              : entry,
          ),
        )
        break
      }
    }
  }
}

// 本函数：生成工具卡片标题，优先用工具自带的 renderCall，失败则回退为原始参数摘要。
function renderTitle(tool: Tool | undefined, name: string, rawArguments: string): string {
  if (!tool?.renderCall) return `${name}(${truncate(rawArguments, 60)})`
  try {
    return tool.renderCall(JSON.parse(rawArguments || '{}'))
  } catch {
    return `${name}(${truncate(rawArguments, 60)})`
  }
}

// 本函数：把工具执行结果落成卡片终态（完成 / 出错 / 被拒绝）。
function finishCard(
  card: ToolCardProps,
  event: { result: string; isError: boolean; call: { name: string } },
  tool: Tool | undefined,
): ToolCardProps {
  if (event.isError) {
    const denied = event.result.startsWith('PermissionDenied')
    return {
      ...card,
      status: denied ? 'denied' : 'error',
      summary: truncate(event.result.split('\n')[0] ?? '', 120),
    }
  }
  void tool
  return { ...card, status: 'done', summary: truncate(firstLine(event.result), 120) }
}

// 本函数：取结果首行作为摘要，并标注剩余行数。
function firstLine(text: string): string {
  const lines = text.split('\n').filter(Boolean)
  if (lines.length === 0) return 'done'
  return lines.length === 1 ? lines[0]! : `${lines[0]!}  (+${lines.length - 1} lines)`
}

// 本函数：超长文本截断为带省略号的固定长度。
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}
