// 本文件：会话消息与工具调用的类型定义，以及转换为 API 传输格式的边界函数。
import type OpenAI from 'openai'

/**
 * Our conversation unit. We stay close to the OpenAI wire format so that
 * `toApiMessages` is nearly a no-op, but we keep our own type so that UI-only
 * message kinds can exist without leaking to the API.
 * 会话单元。刻意贴近 OpenAI 传输格式，使 `toApiMessages` 近乎空操作；
 * 但仍保留自有类型，让仅供 UI 的消息种类存在而不泄漏到 API。
 *
 * cf. src/types/message.ts in the Claude Code tree, which has six kinds
 * (user, assistant, attachment, system, progress, tombstone) and strips the
 * UI-only ones at the normalizeMessagesForAPI boundary.
 * 参见 Claude Code 的 src/types/message.ts：共六种，并在 normalizeMessagesForAPI
 * 边界剥离仅供 UI 的种类。
 */
export type ApiMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string; isError?: boolean }
  /**
   * Never sent to the API — rendered in the transcript only.
   * 绝不发送给 API，仅在会话记录中渲染。
   */
  | { role: 'system-ui'; content: string }

export type ToolCall = {
  id: string
  name: string
  /**
   * Raw JSON string from the model; parsed and validated at dispatch time.
   * 模型返回的原始 JSON 字符串，在分发时才解析和校验。
   */
  arguments: string
}

/**
 * Drop UI-only messages and convert to the wire format.
 * 丢弃仅供 UI 的消息，并转换为传输格式。
 */
// 本函数：丢弃仅供 UI 的消息，把内部 Message 转换成 OpenAI 的传输格式。
export function toApiMessages(messages: Message[]): ApiMessage[] {
  const out: ApiMessage[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'system-ui':
        continue
      case 'user':
        out.push({ role: 'user', content: message.content })
        break
      case 'assistant':
        out.push({
          role: 'assistant',
          content: message.content || null,  // 只带工具调用、没有文本时必须发 null 而非空串，否则部分供应商会判为非法请求
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map(call => ({
                  id: call.id,
                  type: 'function' as const,
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        })
        break
      case 'tool':
        out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content })
        break
    }
  }
  return out
}
