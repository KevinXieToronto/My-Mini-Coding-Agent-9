// 本文件：上下文压缩——先裁剪陈旧的大工具结果，不够再让模型总结旧消息并替换之。
import type { Settings } from '../../utils/config.js'
import type { Message } from '../../types/message.js'
import { toApiMessages } from '../../types/message.js'
import { streamAssistantTurn } from '../api/stream.js'
import { estimateMessageTokens } from '../../utils/tokens.js'

/**
 * Context compaction.
 * 上下文压缩。
 *
 * Two mechanisms, cheapest first:
 * 两套机制，先便宜的：
 *
 *   1. SNIP      truncate old, oversized tool results in place. No model call,
 *                no lost structure. Often enough on its own.
 *      SNIP     原地截断陈旧的超大工具结果。不调模型、不破坏结构，通常已够用。
 *   2. COMPACT   ask the model to summarise the old half of the conversation,
 *                and replace it with that summary.
 *      COMPACT  让模型总结会话的前半部分，并用摘要取而代之。
 *
 * Both preserve a TAIL of recent messages verbatim, because the last few turns
 * are what the model is actually working from.
 * 两者都原样保留末尾若干条消息——模型真正依赖的正是最近几个回合。
 *
 * The whole thing is a loop transition, not an error path: a turn that
 * overflows its context summarises and CONTINUES.
 * 这整件事是循环内的状态转移，而非错误路径：上下文溢出的回合先总结，然后继续。
 *
 * cf. src/services/compact/ in the Claude Code tree, which has five distinct
 * mechanisms (snip, microcompact, context collapse, autocompact, reactive
 * compact).
 * 参见 Claude Code 的 src/services/compact/：那里有五种机制
 * （snip、microcompact、context collapse、autocompact、reactive compact）。
 */

/** Recent messages that are never compacted. */
/** 末尾这些条最近消息永不压缩。 */
const KEEP_TAIL = 6
/** Tool results longer than this get snipped first. */
/** 超过此长度的工具结果优先被裁剪。 */
const SNIP_THRESHOLD_CHARS = 2_000
const SNIP_KEEP_CHARS = 400

export type CompactResult = {
  messages: Message[]
  tokensBefore: number
  tokensAfter: number
  method: 'snip' | 'summary' | 'none'
  summary?: string
}

// 本函数：估算一组消息的 token 总量。
function totalTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}

/**
 * Truncate large old tool results.
 * 截断陈旧的大体积工具结果。
 *
 * A 40 KB `Grep` result mattered for one turn. Ten turns later it is dead
 * weight, and it is almost always the biggest thing in the window. We keep the
 * head so the model can still see what the call returned.
 * 40 KB 的 `Grep` 结果只在当回合有用，十个回合后就是死重，而且几乎总是窗口里最大的一块。
 * 保留开头部分，让模型仍能看出这次调用返回了什么。
 */
// 本函数：把末尾保留区之外、超长的工具结果截断为“开头 + 省略说明”。
export function snipOldToolResults(messages: Message[]): Message[] {
  const cutoff = Math.max(0, messages.length - KEEP_TAIL)
  return messages.map((message, index) => {
    if (index >= cutoff) return message
    if (message.role !== 'tool') return message
    if (message.content.length <= SNIP_THRESHOLD_CHARS) return message
    return {
      ...message,
      content:
        `${message.content.slice(0, SNIP_KEEP_CHARS)}\n` +
        `... [${message.content.length - SNIP_KEEP_CHARS} characters snipped to save context]`,
    }
  })
}

const SUMMARY_PROMPT = `Summarise the conversation so far for your own future reference.

You are writing notes to yourself. Another instance of you will continue this
work with ONLY your summary and the last few messages. Include:

1. What the user asked for, in their words where it matters.
2. What has been done: files created or changed, and how.
3. What was learned about the codebase: structure, conventions, gotchas.
4. What is still outstanding, and what the immediate next step is.
5. Any decision the user made that constrains the approach.

Be specific. Name files and functions. Do not editorialise, do not thank
anyone, and do not describe the conversation as a conversation.`

/**
 * Summarise everything except the tail, and replace it with one user message.
 * 总结除末尾保留区之外的全部消息，并用一条 user 消息取代它们。
 *
 * The summary is stored as a 'user' message rather than a 'system' one so it
 * survives our own `withSystemPrompt` handling and cannot be confused with
 * the agent's instructions.
 * 摘要存为 'user' 而非 'system'：既不会被自己的 `withSystemPrompt` 处理掉，
 * 也不会与 agent 的指令混淆。
 */
// 本函数：执行一次压缩——先 snip，收效不足再调模型生成摘要并替换旧消息。
export async function compactConversation(
  messages: Message[],
  settings: Settings,
  signal?: AbortSignal,
): Promise<CompactResult> {
  const tokensBefore = totalTokens(messages)

  // Cheap pass first.
  // 先走便宜的那一遍。
  const snipped = snipOldToolResults(messages)
  const afterSnip = totalTokens(snipped)
  if (afterSnip < tokensBefore * 0.7) {
    return { messages: snipped, tokensBefore, tokensAfter: afterSnip, method: 'snip' }
  }

  const cutoff = Math.max(0, snipped.length - KEEP_TAIL)
  const head = snipped.slice(0, cutoff)
  const tail = snipped.slice(cutoff)
  if (head.length === 0) {
    return { messages: snipped, tokensBefore, tokensAfter: afterSnip, method: 'none' }
  }

  let summary = ''
  for await (const event of streamAssistantTurn({
    messages: [...toApiMessages(head), { role: 'user', content: SUMMARY_PROMPT }],
    settings,
    signal,
  })) {
    if (event.type === 'done') summary = event.text
  }

  if (!summary.trim()) {
    // The summary call failed. Keep the snipped version rather than losing
    // the conversation — degrading is fine, destroying is not.
    // 摘要调用失败：保留 snip 后的版本，不丢会话——降级可以，摧毁不行。
    return { messages: snipped, tokensBefore, tokensAfter: afterSnip, method: 'snip' }
  }

  const compacted: Message[] = [
    {
      role: 'user',
      content: `[Earlier conversation, compacted to save context]\n\n${summary}`,
    },
    ...ensureToolPairsIntact(tail),
  ]

  return {
    messages: compacted,
    tokensBefore,
    tokensAfter: totalTokens(compacted),
    method: 'summary',
    summary,
  }
}

/**
 * Drop leading orphans.
 * 丢弃开头的孤儿消息。
 *
 * If the tail happens to begin with a `tool` message whose `tool_calls`
 * assistant message got summarised away, the very next request is a 400. This
 * is the single easiest way to break compaction, so we check for it explicitly.
 * 若末尾保留区恰好以 `tool` 消息开头，而携带 `tool_calls` 的 assistant 消息已被总结掉，
 * 下一次请求就是 400。这是压缩最容易翻车的地方，因此显式检查。
 */
// 本函数：去掉末尾保留区开头那些找不到配对 assistant 消息的 tool 消息。
function ensureToolPairsIntact(tail: Message[]): Message[] {
  let start = 0
  while (start < tail.length && tail[start]!.role === 'tool') start += 1
  return tail.slice(start)
}
