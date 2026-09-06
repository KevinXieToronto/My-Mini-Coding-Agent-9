/**
 * A minimal OpenAI-compatible streaming server, for developing mini-cc without
 * burning API credits.
 *
 *   node tools-dev/stub-server.mjs
 *   set OPENAI_BASE_URL=http://127.0.0.1:8787/v1
 *
 * Behaviour: it echoes the last user message. If that message starts with
 * "call:" it instead emits a tool call, e.g.
 *   call: ListDir {"path":"src"}
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.STUB_PORT ?? 8787)

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function frame(delta, finish = null) {
  return {
    id: 'chatcmpl-stub',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'stub',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

createServer((req, res) => {
  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', chunk => (body += chunk))
  req.on('end', () => {
    const request = JSON.parse(body || '{}')
    const messages = request.messages ?? []
    const last = messages[messages.length - 1]
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    // If the previous step was a tool result, summarise it rather than looping
    // forever on the same instruction. Chapter 3 needs this.
    const text =
      last?.role === 'tool'
        ? 'done: ' + String(last.content).split('\n')[0]
        : typeof lastUser?.content === 'string'
          ? lastUser.content
          : ''

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    if (text.startsWith('call:')) {
      const rest = text.slice('call:'.length).trim()
      const space = rest.indexOf(' ')
      const name = space === -1 ? rest : rest.slice(0, space)
      const args = space === -1 ? '{}' : rest.slice(space + 1)
      sse(res, frame({ role: 'assistant', content: '' }))
      sse(res, frame({ tool_calls: [{ index: 0, id: 'call_stub_1', type: 'function', function: { name, arguments: '' } }] }))
      // Deliberately fragment the arguments, to prove the accumulator works.
      for (const piece of args.match(/.{1,8}/g) ?? []) {
        sse(res, frame({ tool_calls: [{ index: 0, function: { arguments: piece } }] }))
      }
      sse(res, frame({}, 'tool_calls'))
    } else {
      const reply = `You said: ${text}`
      sse(res, frame({ role: 'assistant', content: '' }))
      for (const piece of reply.match(/.{1,5}/g) ?? []) {
        sse(res, frame({ content: piece }))
      }
      sse(res, frame({}, 'stop'))
    }

    sse(res, {
      id: 'chatcmpl-stub',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'stub',
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
    res.write('data: [DONE]\n\n')
    res.end()
  })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`stub OpenAI server on http://127.0.0.1:${PORT}/v1`)
})
