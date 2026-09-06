import type OpenAI from 'openai'

/**
 * Our conversation unit. We stay close to the OpenAI wire format so that
 * `toApiMessages` is nearly a no-op, but we keep our own type so that UI-only
 * message kinds can exist without leaking to the API.
 *
 * cf. src/types/message.ts in the Claude Code tree, which has six kinds
 * (user, assistant, attachment, system, progress, tombstone) and strips the
 * UI-only ones at the normalizeMessagesForAPI boundary.
 */
export type ApiMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string; isError?: boolean }
  /** Never sent to the API — rendered in the transcript only. */
  | { role: 'system-ui'; content: string }

export type ToolCall = {
  id: string
  name: string
  /** Raw JSON string from the model; parsed and validated at dispatch time. */
  arguments: string
}

/** Drop UI-only messages and convert to the wire format. */
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
          content: message.content || null,
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
