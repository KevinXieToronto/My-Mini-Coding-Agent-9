import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import type { Settings } from '../utils/config.js'
import type { Message } from '../types/message.js'
import { toApiMessages } from '../types/message.js'
import { streamAssistantTurn } from '../services/api/stream.js'
import { PRODUCT_NAME, VERSION } from '../constants/product.js'

/**
 * A deliberately primitive REPL. It exists for two chapters only — Chapter 7
 * replaces it with an Ink application. Keeping it dumb now means the agent loop
 * in Chapter 3 is the only interesting thing on screen.
 */
export async function runReadlineREPL(settings: Settings): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout })
  const messages: Message[] = []

  console.log(`${PRODUCT_NAME} v${VERSION}  ·  model: ${settings.model}`)
  console.log('Type your message, or /exit to quit.\n')

  let closed = false
  rl.on('close', () => {
    closed = true
  })

  try {
    while (!closed) {
      // question() rejects when stdin reaches EOF (Ctrl+Z on Windows, or a pipe
      // running dry). That is a normal exit, not an error.
      let line: string
      try {
        line = (await rl.question('You: ')).trim()
      } catch {
        break
      }
      if (!line) continue
      if (line === '/exit' || line === '/quit') break

      messages.push({ role: 'user', content: line })

      stdout.write('\nAssistant: ')
      let finalText = ''
      for await (const event of streamAssistantTurn({
        messages: toApiMessages(messages),
        settings,
      })) {
        if (event.type === 'text_delta') stdout.write(event.text)
        if (event.type === 'done') finalText = event.text
      }
      stdout.write('\n\n')

      messages.push({ role: 'assistant', content: finalText })
    }
  } finally {
    rl.close()
  }
}
