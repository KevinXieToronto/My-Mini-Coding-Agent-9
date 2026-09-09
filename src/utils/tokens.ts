// 本文件：token 记账——估算会话用量、按模型给出上下文窗口与压缩阈值，并累计费用。
import type { Message } from '../types/message.js'

/**
 * Token accounting.
 * token 记账。
 *
 * We estimate rather than tokenize. A real BPE tokenizer is a large dependency
 * and is wrong for every model except the one it was built for, and we only
 * need to answer one question: "are we close to the limit?" Being 10% out on
 * that is fine, because the threshold has a buffer anyway.
 * 我们只估算，不做真正的分词：BPE 分词器体积大，且换个模型就不准；
 * 而我们只需回答“是否接近上限”，误差 10% 无妨——阈值本就留了余量。
 *
 * The API tells us the true count in `usage` after each turn, so we correct
 * ourselves as we go — estimate to decide, measure to report.
 * 每回合结束后 API 会在 `usage` 里给出真实值，可随时校正——估算用于决策，实测用于展示。
 */

/** ~4 characters per token for English source and prose. */
/** 英文代码与散文大致 4 字符 ≈ 1 token。 */
const CHARS_PER_TOKEN = 4
/** Per-message overhead for role and framing. */
/** 每条消息的角色与框架开销。 */
const MESSAGE_OVERHEAD = 4

// 本函数：按字符数粗估一段文本的 token 数。
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

// 本函数：估算单条消息的 token 数；仅供 UI 的消息计 0。
export function estimateMessageTokens(message: Message): number {
  let total = MESSAGE_OVERHEAD
  switch (message.role) {
    case 'user':
    case 'assistant':
      total += estimateTokens(message.content)
      if (message.role === 'assistant' && message.toolCalls) {
        for (const call of message.toolCalls) {
          total += estimateTokens(call.name) + estimateTokens(call.arguments)
        }
      }
      break
    case 'tool':
      total += estimateTokens(message.content)
      break
    case 'system-ui':
      return 0 // never sent
      // 从不发送给 API。
  }
  return total
}

// 本函数：估算整段会话（含系统提示词）的 token 总量。
export function estimateConversationTokens(messages: Message[], systemPrompt = ''): number {
  return (
    estimateTokens(systemPrompt) +
    messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  )
}

/**
 * Context windows, by model-name prefix. Unknown models get a conservative
 * default — guessing high would mean discovering the limit as a 400 error
 * mid-turn, which is the worst possible time.
 * 按模型名前缀给出上下文窗口。未知模型取保守默认值——猜大了只会在回合中途
 * 以 400 错误的形式撞上限，那是最糟的时机。
 */
const CONTEXT_WINDOWS: [prefix: string, tokens: number][] = [
  ['gpt-4.1', 1_000_000],
  ['gpt-4o', 128_000],
  ['gpt-4-turbo', 128_000],
  ['gpt-4', 8_192],
  ['gpt-3.5', 16_385],
  ['o1', 200_000],
  ['o3', 200_000],
  ['qwen', 32_768],
  ['llama', 128_000],
  ['mistral', 32_768],
]

const DEFAULT_CONTEXT_WINDOW = 32_768

// 本函数：按模型名前缀查出上下文窗口大小，查不到则返回保守默认值。
export function contextWindowFor(model: string): number {
  const name = model.toLowerCase()
  for (const [prefix, tokens] of CONTEXT_WINDOWS) {
    if (name.startsWith(prefix)) return tokens
  }
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * Headroom we refuse to spend on history, reserved for the model's own reply
 * plus the summary that compaction has to generate.
 * 预留给模型回复和压缩摘要的余量，历史消息不得占用。
 */
export const RESPONSE_BUFFER_TOKENS = 8_000
export const COMPACT_BUFFER_TOKENS = 5_000

// 本函数：计算触发压缩的 token 阈值（窗口减去两块预留余量）。
export function compactThreshold(model: string): number {
  return Math.max(
    4_000,
    contextWindowFor(model) - RESPONSE_BUFFER_TOKENS - COMPACT_BUFFER_TOKENS,
  )
}

export type TokenState = {
  used: number
  window: number
  threshold: number
  percentUsed: number
  shouldCompact: boolean
}

// 本函数：汇总当前会话的用量、窗口、阈值与是否需要压缩。
export function tokenState(messages: Message[], systemPrompt: string, model: string): TokenState {
  const used = estimateConversationTokens(messages, systemPrompt)
  const window = contextWindowFor(model)
  const threshold = compactThreshold(model)
  return {
    used,
    window,
    threshold,
    percentUsed: Math.round((used / window) * 100),
    shouldCompact: used > threshold,
  }
}

/**
 * Cost, in US dollars per million tokens. These change; treat them as a
 * starting point and put your real numbers in settings.
 * 每百万 token 的美元单价。价格会变，这里只是起点，真实数字请写进 settings。
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
}

// 本类：累计各次请求的输入/输出 token，并据单价估算总花费。
export class CostTracker {
  promptTokens = 0
  completionTokens = 0
  requests = 0

  // 本函数：记录一次请求的用量；usage 缺失时只累加请求数。
  record(usage: { promptTokens: number; completionTokens: number } | undefined): void {
    this.requests += 1
    if (!usage) return
    this.promptTokens += usage.promptTokens
    this.completionTokens += usage.completionTokens
  }

  /** undefined when we have no price for the model — better than a wrong number. */
  /** 没有该模型的价目时返回 undefined——好过给出错误数字。 */
  // 本函数：按模型单价估算累计花费（美元）。
  estimateCost(model: string): number | undefined {
    const price = PRICING[model.toLowerCase()]
    if (!price) return undefined
    return (
      (this.promptTokens / 1_000_000) * price.input +
      (this.completionTokens / 1_000_000) * price.output
    )
  }
}
