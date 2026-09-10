// 本文件：交互式 REPL 界面——整个应用的主屏，把代理循环的事件流接到 React 状态与各组件上。
import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import type React from 'react'
import type { Settings } from '../utils/config.js'
import type { Message } from '../types/message.js'
import type { Tool, ToolContext } from '../Tool.js'
import type { Usage } from '../services/api/stream.js'
import { query, type CanUseTool, type Terminal } from '../query.js'
import { getToolsWithAgent } from '../tools.js'
import { loadSkills } from '../skills/loadSkills.js'
import { TodoPanel } from '../components/TodoPanel.js'
import { PRODUCT_NAME, VERSION } from '../constants/product.js'
import { buildSessionContext, expandUserMentions } from '../context.js'
import { buildPermissionContext } from '../utils/config.js'
import { FileHistory } from '../utils/fileHistory.js'
import { createAppState } from '../state/appState.js'
import { runContextHooks } from '../utils/hooks.js'
import {
  SessionWriter,
  messagesFromTranscript,
  readTranscript,
  type SessionSummary,
} from '../utils/sessionStorage.js'
import { getSystemPrompt } from '../constants/prompts.js'
import { CostTracker } from '../utils/tokens.js'
import { Markdown } from '../components/Markdown.js'
import { ToolCard, type ToolCardProps } from '../components/ToolCard.js'
import { PermissionModal, type PermissionRequest } from '../components/PermissionModal.js'
import { Spinner } from '../components/Spinner.js'
import { PromptInput } from '../components/PromptInput.js'
import { findCommand, getCommands, parseCommandLine } from '../commands.js'
import { makeCostCommand, makeRewindCommand } from '../commands/builtins.js'
import type { Command, CommandContext } from '../types/command.js'

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

/**
 * What main.ts hands over after connecting the MCP servers: the wrapped tools,
 * the servers' own instructions, and one line per server that did not connect.
 * main.ts 连接 MCP 服务器后交过来的东西：包装好的工具、服务器自带的说明，
 * 以及每台未连上的服务器一行的失败信息。
 */
export type McpBundle = { tools: Tool[]; instructions: string; failures: string[] }

export type REPLProps = { settings: Settings; resume?: SessionSummary; mcp?: McpBundle }

// 本组件：REPL 主屏，持有会话状态、转录列表、授权弹窗与输入框，并负责会话记录与回退。
export function REPL({ settings, resume, mcp }: REPLProps): React.ReactElement {
  const { exit } = useApp()
  const { stdout } = useStdout()

  // Seeded with the MCP failures, so a server that did not connect says so in
  // the transcript instead of silently not being there.
  // 以 MCP 失败信息作为初值：连不上的服务器会在转录里说明自己，而不是无声无息地消失。
  const [entries, setEntries] = useState<Entry[]>(
    (mcp?.failures ?? []).map(text => ({ kind: 'notice' as const, text })),
  )
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
  // Checkpoints and the transcript writer are session-scoped, like the tool list.
  // 检查点与会话记录写入器和工具列表一样，都是会话级的。
  const fileHistoryRef = useRef(new FileHistory())
  const writerRef = useRef<SessionWriter>(new SessionWriter(process.cwd(), resume?.sessionId))
  // Usage accumulates across the whole session, so it lives in a ref too.
  // 用量要跨整个会话累计，因此同样放进 ref。
  const costRef = useRef(new CostTracker())
  const sessionRef = useRef<Omit<ToolContext, 'abortController'>>({
    cwd: process.cwd(),
    readFileState: new Map(),
    sessionAllow: new Set(),
    permissions: buildPermissionContext(settings, process.cwd()),
    fileHistory: fileHistoryRef.current,
    messageIndex: () => messagesRef.current.length,
    appState: createAppState(),
    // Hooks are read once, with the rest of the settings: re-reading
    // settings.json mid-session would let a file change what the user already
    // consented to when they started this session.
    // 钩子随设置一次读入：会话中途重读 settings.json，
    // 等于让一个文件改掉用户启动会话时已经认可的东西。
    hooks: settings.hooks ?? {},
    sessionId: writerRef.current.sessionId,
  })
  const permissionContext = sessionRef.current.permissions
  // Built after the permission context, because the advertised tool list is
  // mode-dependent: ExitPlanMode only exists in plan mode.
  // 放在权限上下文之后构建：对外暴露的工具表与模式相关——ExitPlanMode 仅存在于 plan 模式。
  // Scanned once, like the commands: the Skill tool closes over this list and
  // the prompt's Skills section is built from the same scan.
  // 与命令一样只扫描一次：Skill 工具闭包持有该列表，提示词的技能区块也源自同一次扫描。
  const skillsRef = useLazyRef(() => loadSkills(process.cwd()))
  const toolsRef = useLazyRef<Tool[]>(() =>
    getToolsWithAgent(settings, permissionContext.mode, skillsRef.current, mcp?.tools ?? []),
  )
  // Built once: git status and MINI.md are session-scoped, and rebuilding them
  // every turn would break the provider's prompt cache for no real benefit.
  // 只构建一次：git 状态与 MINI.md 属于会话级信息，逐回合重建只会白白打断服务商的提示词缓存。
  //
  // It has to go through useLazyRef to actually be built once — see the note there.
  // 必须经由 useLazyRef 才真的只构建一次——原因见该函数处的说明。
  const systemPromptRef = useLazyRef(() =>
    getSystemPrompt(toolsRef.current, buildSessionContext(process.cwd(), mcp?.instructions)),
  )

  // Built once, at mount: scanning the command directories on every render
  // would stat the filesystem for every streamed token.
  // 只在挂载时构建一次：每次渲染都扫描命令目录，等于每个流式 token 都要访问文件系统。
  const commandsRef = useLazyRef<Command[]>(() => [
    ...getCommands(process.cwd()),
    makeCostCommand(costRef.current),
    makeRewindCommand(fileHistoryRef.current),
  ])

  // Replay a resumed transcript into the UI, once.
  // 恢复的会话记录只回放一次到界面上。
  const [restored, setRestored] = useState(false)
  if (resume && !restored) {
    const entries = readTranscript(resume.path)
    messagesRef.current = messagesFromTranscript(entries)
    // Continue the existing chain instead of opening a second root node.
    // 接续已有链条，而不是开出第二个根节点。
    writerRef.current.setParent(entries.at(-1)?.uuid ?? null)
    setEntries(entriesFromMessages(messagesRef.current))
    setRestored(true)
  }

  /**
   * SessionStart fires once, at mount. Its context becomes a real user message
   * — `system-ui` would render nicely and never reach the model, which is the
   * opposite of what a hook injecting context wants.
   * SessionStart 在挂载时触发一次。它注入的上下文会变成一条真正的 user 消息——
   * 用 `system-ui` 虽好看却永远到不了模型那里，与「注入上下文」的初衷正好相反。
   */
  useEffect(() => {
    let cancelled = false
    void runContextHooks(
      sessionRef.current.hooks,
      'SessionStart',
      {
        hook_event_name: 'SessionStart',
        session_id: sessionRef.current.sessionId,
        cwd: sessionRef.current.cwd,
      },
      sessionRef.current.cwd,
    ).then(result => {
      if (cancelled || !result.additionalContext) return
      const message: Message = { role: 'user', content: result.additionalContext }
      messagesRef.current.push(message)
      writerRef.current.append(message)
      setEntries(previous => [
        ...previous,
        { kind: 'notice', text: `[SessionStart hook] ${result.additionalContext}` },
      ])
    })
    return () => {
      cancelled = true
    }
  }, [])

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
          resolve: answer => {  // 把弹窗按键结果兑现给 canUseTool 的 Promise，代理循环正停在那个 await 上等它
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
      // Slash commands are dispatched through the registry (Ch.13), not
      // matched inline. A 'prompt' command rewrites `text` and falls through
      // to the normal path; a 'local' command handles itself and returns.
      // 斜杠命令交由注册表分发（第 13 章），不再逐条 if 匹配：
      // 'prompt' 命令改写 `text` 后走正常路径，'local' 命令自行处理并返回。
      let effectiveText = text
      const parsed = parseCommandLine(text)
      if (parsed) {
        const command = findCommand(commandsRef.current, parsed.name)
        if (!command) {
          setEntries(previous => [
            ...previous,
            { kind: 'user', text },
            { kind: 'notice', text: `Unknown command /${parsed.name}. Try /help.` },
          ])
          return
        }

        const commandContext: CommandContext = {
          settings,
          cwd: sessionRef.current.cwd,
          messages: messagesRef.current,
          systemPrompt: systemPromptRef.current,
          appState: sessionRef.current.appState,
          setMessages: next => {
            messagesRef.current.splice(0, messagesRef.current.length, ...next)  // 就地替换而非重新赋值：query 循环持有的是同一个数组引用，换引用它就看不见了
            setEntries(entriesFromMessages(messagesRef.current))
          },
          notify: notice => setEntries(previous => [...previous, { kind: 'notice', text: notice }]),
        }

        if (command.type === 'local') {
          setEntries(previous => [...previous, { kind: 'user', text }])
          setBusy(true)
          try {
            const result = await command.call(parsed.args, commandContext)
            if (result.type === 'exit') {
              exit()
              return
            }
            if (result.type === 'text') commandContext.notify(result.text)
          } catch (error) {
            commandContext.notify(`/${parsed.name} failed: ${String(error)}`)
          } finally {
            // The permission engine reads its own context, not Settings, so a
            // /mode change has to be mirrored across for it to take effect.
            // 权限引擎读的是自己的上下文而非 Settings，/mode 的改动需同步过去才生效。
            sessionRef.current.permissions.mode = settings.permissionMode  // 放在 finally 里：无论命令成功还是抛错，模式改动都要同步到权限上下文
            setBusy(false)
          }
          return
        }

        // A prompt command expands into what the user "said".
        // 提示词命令展开成用户「说过的话」。
        effectiveText = await command.getPrompt(parsed.args, commandContext)
      }

      setEntries(previous => [...previous, { kind: 'user', text }])

      // UserPromptSubmit is the one hook that sees the prompt before the model
      // does. It runs AFTER command expansion, so a hook guards what is
      // actually sent, not what was typed.
      // UserPromptSubmit 是唯一能在模型之前看到提问的钩子。
      // 它在命令展开之后运行，因此守的是「真正发出去的内容」，而非用户敲下的字面。
      const submitted = await runContextHooks(
        sessionRef.current.hooks,
        'UserPromptSubmit',
        {
          hook_event_name: 'UserPromptSubmit',
          session_id: sessionRef.current.sessionId,
          cwd: sessionRef.current.cwd,
          prompt: effectiveText,
        },
        sessionRef.current.cwd,
      )
      if (submitted.blocked) {
        setEntries(previous => [
          ...previous,
          { kind: 'notice', text: `Blocked by a hook: ${submitted.reason ?? 'no reason given'}` },
        ])
        return
      }

      // @path mentions are expanded for the MODEL only; the transcript keeps
      // showing what the user actually typed.
      // @path 提及只为模型展开；转录里仍显示用户实际输入的文本。
      const expanded = expandUserMentions(effectiveText, sessionRef.current.cwd)  // 展开结果只进消息列表，不回写转录，故界面上仍是用户敲下的原文
      const userMessage: Message = {
        role: 'user',
        content: submitted.additionalContext
          ? `${expanded}

<hook-context>
${submitted.additionalContext}
</hook-context>`
          : expanded,
      }
      messagesRef.current.push(userMessage)
      writerRef.current.append(userMessage)

      const abortController = new AbortController()
      abortRef.current = abortController
      setBusy(true)

      try {
        const terminal = await drive({
          messages: messagesRef.current,
          settings,
          tools: toolsRef.current,
          toolContext: { ...sessionRef.current, abortController },  // 会话级上下文加上本回合专属的中断控制器，拼成完整 ToolContext
          systemPrompt: systemPromptRef.current,
          canUseTool,
          onMessage: message => writerRef.current.append(message),
          onUsage: usage => costRef.current.record(usage),
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

      <TodoPanel
        todos={sessionRef.current.appState.todos.main ?? []}
        version={entries.length}
      />

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

/**
 * Rebuild transcript entries from a message list. Used after a resume and
 * after a rewind. Tool calls collapse to a single card — we did not persist
 * the UI state, only the API messages, which is the right trade: the
 * transcript file stays small and provider-shaped.
 * 从消息列表重建转录记录，用于恢复会话与回退之后。工具调用坍缩成单张卡片——
 * 我们只持久化 API 消息、不存 UI 状态，这个取舍是对的：记录文件小且贴合供应商格式。
 */
// 本函数：把消息列表还原成界面上的转录记录数组。
function entriesFromMessages(messages: Message[]): Entry[] {
  const entries: Entry[] = []
  for (const message of messages) {
    if (message.role === 'user') entries.push({ kind: 'user', text: message.content })
    else if (message.role === 'assistant' && message.content.trim()) {
      entries.push({ kind: 'assistant', text: message.content })
    } else if (message.role === 'tool') {
      entries.push({
        kind: 'tool',
        id: message.toolCallId,
        card: {
          title: 'tool',
          status: message.isError ? 'error' : 'done',
          summary: message.content.split('\n')[0]?.slice(0, 100),
        },
      })
    }
  }
  return entries
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
// 本函数：惰性 ref——初值只在首次渲染时计算一次，避免每次渲染重复执行昂贵的构建。
function useLazyRef<T>(make: () => T): React.MutableRefObject<T> {
  const ref = useRef<T | undefined>(undefined)
  if (ref.current === undefined) ref.current = make()  // 只在首帧 make 求值一次；写成 useRef(make()) 则每次渲染都会执行 make
  return ref as React.MutableRefObject<T>
}

type DriveParams = {
  messages: Message[]
  settings: Settings
  tools: Tool[]
  toolContext: ToolContext
  systemPrompt?: string
  canUseTool: CanUseTool
  onMessage?: (message: Message) => void
  onUsage: (usage: Usage) => void
  setEntries: React.Dispatch<React.SetStateAction<Entry[]>>
  setStreamingText: React.Dispatch<React.SetStateAction<string>>
}

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
// 本函数：驱动 query 生成器，把事件分发成 React 状态更新，并返回回合终态。
async function drive(params: DriveParams): Promise<Terminal> {
  const { setEntries, setStreamingText, onUsage, ...queryParams } = params  // 解构剥掉 UI 专属回调，余下的正好是 query 需要的参数，UI 关注点不渗进循环
  const iterator = query(queryParams)
  const toolsByName = new Map(params.tools.map(tool => [tool.name, tool]))

  while (true) {
    const step = await iterator.next()
    if (step.done) return step.value  // 生成器 done 时 value 才是 Terminal 终值，事件则来自未完成的每一步
    const event = step.value

    switch (event.type) {
      case 'text_delta':
        setStreamingText(previous => previous + event.text)
        break

      case 'compacted':
        setEntries(previous => [
          ...previous,
          {
            kind: 'notice',
            text: `[auto-compacted via ${event.method}: ~${event.tokensBefore} -> ~${event.tokensAfter} tokens]`,
          },
        ])
        break

      case 'assistant_message': {
        const text = event.message.role === 'assistant' ? event.message.content : ''
        if (event.usage) onUsage(event.usage)
        setStreamingText('')  // 清空流式文本与下一行的追加同处一个 React 批次，故切到定稿文本时不会闪烁
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
              ? { ...entry, card: finishCard(entry.card, event, tool) }  // 按调用 id 定位那张卡片就地更新，其余条目保持原对象引用以免整列重渲染
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
