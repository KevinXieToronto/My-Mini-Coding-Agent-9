import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import type { Settings } from '../utils/config.js'
import type { Message } from '../types/message.js'
import { query, type Terminal } from '../query.js'
import { getAllTools } from '../tools.js'
import { PRODUCT_NAME, VERSION } from '../constants/product.js'

/**
 * A deliberately primitive REPL. Chapter 7 replaces it with an Ink
 * application; keeping it dumb now means the agent loop is the only
 * interesting thing on screen.
 */
export async function runReadlineREPL(settings: Settings): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout })
  const messages: Message[] = []
  const tools = getAllTools()

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
    const abortController = new AbortController()
    const onSigint = () => {
      abortController.abort('interrupt')
    }
    rl.on('SIGINT', onSigint)

    try {
      const terminal = await drainTurn(messages, settings, tools, abortController)
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
 */
async function drainTurn(
  messages: Message[],
  settings: Settings,
  tools: ReturnType<typeof getAllTools>,
  abortController: AbortController,
): Promise<Terminal> {
  const iterator = query({
    messages,
    settings,
    tools,
    toolContext: { cwd: process.cwd(), abortController },
  })

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

function compact(json: string): string {
  const text = json.replace(/\s+/g, ' ').trim()
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

function preview(result: string): string {
  const lines = result.split('\n')
  if (lines.length <= 6) return result
  return `${lines.slice(0, 6).join('\n')}\n... (+${lines.length - 6} lines)`
}

function indent(text: string): string {
  return text.split('\n').join('\n     ')
}
