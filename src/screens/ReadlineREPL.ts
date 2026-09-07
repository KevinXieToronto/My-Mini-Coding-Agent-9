// 本文件：基于 readline 的最简交互式 REPL，负责读取用户输入、驱动代理循环并渲染其事件。
import { createInterface, type Interface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import type { Settings } from '../utils/config.js'
import type { Message } from '../types/message.js'
import type { ToolContext } from '../Tool.js'
import { query, type CanUseTool, type QueryParams, type Terminal } from '../query.js'
import { getAllTools } from '../tools.js'
import { PRODUCT_NAME, VERSION } from '../constants/product.js'

/**
 * A deliberately primitive REPL. Chapter 7 replaces it with an Ink
 * application; keeping it dumb now means the agent loop is the only
 * interesting thing on screen.
 * 刻意做得简陋的 REPL。第 7 章会换成 Ink 应用；此刻保持朴素，
 * 是为了让屏幕上唯一值得注意的东西是代理循环本身。
 */
// 本函数：REPL 主循环——逐行读取输入，每回合建立 AbortController 使 Ctrl+C 只中断当前回合。
export async function runReadlineREPL(settings: Settings): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout })
  const messages: Message[] = []
  const tools = getAllTools()

  // Session-level state, hoisted out of the loop so "always allow" and the
  // read-before-write cache survive across turns.
  // 会话级状态提到循环外，使「总是允许」与「先读后写」缓存跨回合存活。
  const toolContext: Omit<ToolContext, 'abortController'> = {
    cwd: process.cwd(),
    readFileState: new Map(),
    sessionAllow: new Set(),
  }

  console.log(`${PRODUCT_NAME} v${VERSION}  ·  model: ${settings.model}`)
  console.log(`tools: ${tools.map(t => t.name).join(', ')}`)
  console.log('Type your message, /exit to quit, Ctrl+C to interrupt a running turn.\n')

  let closed = false
  rl.on('close', () => {
    closed = true
  })

  while (!closed) {
    let line: string
    try {
      line = (await rl.question('You: ')).trim()
    } catch {
      break
    }
    if (!line) continue
    if (line === '/exit' || line === '/quit') break

    messages.push({ role: 'user', content: line })

    // One AbortController per turn. Ctrl+C aborts the turn, not the process.
    // 每回合一个 AbortController。Ctrl+C 中断的是回合，不是进程。
    const abortController = new AbortController()
    const onSigint = () => {
      abortController.abort('interrupt')
    }
    rl.on('SIGINT', onSigint)

    try {
      const terminal = await drainTurn({
        messages,
        settings,
        tools,
        toolContext: { ...toolContext, abortController },
        canUseTool: makeApprovalPrompt(rl, toolContext.sessionAllow),
      })
      reportTerminal(terminal)
    } finally {
      rl.off('SIGINT', onSigint)
    }
  }

  rl.close()
}

/**
 * Consume the agent loop's events. Note the `for await ... of` cannot give us
 * the generator's RETURN value, so we drive the iterator by hand.
 * 消费代理循环产出的事件。注意 `for await ... of` 拿不到生成器的 return 值，
 * 因此手动驱动迭代器。
 */
// 本函数：手动驱动 query 生成器，边渲染事件边取得生成器的回合终止原因。
async function drainTurn(params: QueryParams): Promise<Terminal> {
  const iterator = query(params)

  let printedAssistantPrefix = false

  while (true) {
    const step = await iterator.next()
    if (step.done) return step.value

    const event = step.value
    switch (event.type) {
      case 'text_delta':
        if (!printedAssistantPrefix) {
          stdout.write('\nAssistant: ')
          printedAssistantPrefix = true
        }
        stdout.write(event.text)
        break
      case 'assistant_message':
        if (printedAssistantPrefix) stdout.write('\n')
        printedAssistantPrefix = false
        break
      case 'tool_start':
        stdout.write(`\n● ${event.call.name}(${compact(event.call.arguments)})\n`)
        break
      case 'tool_end':
        stdout.write(`  ⎿  ${indent(preview(event.result))}\n`)
        break
    }
  }
}

// 本函数：按回合终止原因向终端打印相应的结束提示。
function reportTerminal(terminal: Terminal): void {
  switch (terminal.reason) {
    case 'completed':
      stdout.write('\n')
      break
    case 'aborted':
      stdout.write('\n[interrupted]\n\n')
      break
    case 'max_turns':
      stdout.write(`\n[stopped after ${terminal.turns} turns]\n\n`)
      break
    case 'model_error':
      stdout.write(`\n[model error: ${terminal.error}]\n\n`)
      break
  }
}

/**
 * Ask the human. Three answers:
 *   y  yes, once
 *   n  no  (the model gets a tool_result saying so, and adapts)
 *   a  yes, and stop asking for this tool this session
 * 询问人类。三种答复：
 *   y  同意本次
 *   n  拒绝（模型会收到说明此事的 tool_result 并自行调整）
 *   a  同意，且本会话不再为该工具询问
 */
// 本函数：构造权限询问回调，在终端读取 y/n/a 并维护会话级「总是允许」集合。
function makeApprovalPrompt(rl: Interface, sessionAllow: Set<string>): CanUseTool {
  return async ({ tool, message }) => {
    stdout.write(`\n  ⚠  ${message}\n`)
    while (true) {
      const answer = (await rl.question('     Allow? [y]es / [n]o / [a]lways: ')).trim().toLowerCase()
      if (answer === 'y' || answer === 'yes') return true
      if (answer === 'n' || answer === 'no' || answer === '') return false
      if (answer === 'a' || answer === 'always') {
        sessionAllow.add(tool.name)
        return true
      }
    }
  }
}

// 本函数：把工具入参 JSON 压成单行并截断，便于单行展示。
function compact(json: string): string {
  const text = json.replace(/\s+/g, ' ').trim()
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

// 本函数：只保留工具结果的前几行作为预览，避免刷屏。
function preview(result: string): string {
  const lines = result.split('\n')
  if (lines.length <= 6) return result
  return `${lines.slice(0, 6).join('\n')}\n... (+${lines.length - 6} lines)`
}

// 本函数：为多行文本的后续行补齐缩进，使终端输出对齐。
function indent(text: string): string {
  return text.split('\n').join('\n     ')
}
