// 本文件：唯一知晓模型供应商的模块，负责创建并缓存 OpenAI 客户端（可指向 Azure/Ollama/vLLM）。
import OpenAI from 'openai'
import type { Settings } from '../../utils/config.js'

/**
 * The one module that knows which model provider we use.
 * 唯一知道我们用哪家模型供应商的模块。
 *
 * Everything above this line speaks in Messages and ToolCalls; nothing above it
 * imports `openai`. That is the whole reason Claude Code can target Anthropic,
 * Bedrock and Vertex from one agent loop (src/services/api/), and the reason we
 * can target OpenAI, Azure, Ollama or vLLM from one place here.
 * 这条线以上只讲 Message 和 ToolCall，不导入 `openai`。正因如此，Claude Code 能用
 * 一个代理循环对接 Anthropic、Bedrock、Vertex，我们也能在此一处对接
 * OpenAI、Azure、Ollama 或 vLLM。
 */
let client: OpenAI | undefined

// 本函数：惰性创建并缓存客户端，校验 API Key 并支持自定义 baseURL。
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
    // 为 undefined 时回退到 https://api.openai.com/v1。
    baseURL: settings.baseURL ?? process.env.OPENAI_BASE_URL,
    maxRetries: 3,
    timeout: 120_000,
  })
  return client
}

/**
 * Reset between tests, or after the user changes the model at runtime.
 * 用于测试之间、或用户运行时改动模型后的重置。
 */
// 本函数：清空客户端缓存，供测试之间或运行时改动模型后重建。
export function resetClient(): void {
  client = undefined
}
