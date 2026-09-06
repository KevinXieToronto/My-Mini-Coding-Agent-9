import OpenAI from 'openai'
import type { Settings } from '../../utils/config.js'

/**
 * The one module that knows which model provider we use.
 *
 * Everything above this line speaks in Messages and ToolCalls; nothing above it
 * imports `openai`. That is the whole reason Claude Code can target Anthropic,
 * Bedrock and Vertex from one agent loop (src/services/api/), and the reason we
 * can target OpenAI, Azure, Ollama or vLLM from one place here.
 */
let client: OpenAI | undefined

export function getClient(settings: Settings): OpenAI {
  if (client) return client

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. Put it in .env or run: set OPENAI_API_KEY=sk-...',
    )
  }

  client = new OpenAI({
    apiKey,
    // Undefined falls back to https://api.openai.com/v1.
    baseURL: settings.baseURL ?? process.env.OPENAI_BASE_URL,
    maxRetries: 3,
    timeout: 120_000,
  })
  return client
}

/** Reset between tests, or after the user changes the model at runtime. */
export function resetClient(): void {
  client = undefined
}
