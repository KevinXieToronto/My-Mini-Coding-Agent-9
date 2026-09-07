import type OpenAI from 'openai'
import type { Settings } from '../../utils/config.js'
import type { ApiMessage, ToolCall } from '../../types/message.js'
import { getClient } from './client.js'

/**
 * Events yielded while a single model response streams in.
 * 单次模型响应流式返回期间产出的事件。
 * cf. the StreamEvent union threaded through src/query.ts.
 * 参见贯穿 src/query.ts 的 StreamEvent 联合类型。
 */
export type StreamEvent =
  | { type: 'request_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'done'; text: string; toolCalls: ToolCall[]; usage?: Usage }

export type Usage = { promptTokens: number; completionTokens: number }

export type StreamParams = {
  messages: ApiMessage[]
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[]
  settings: Settings
  signal?: AbortSignal
}

/**
 * Stream one assistant turn.
 * 流式处理一次助手回合。
 *
 * The awkward part of the OpenAI streaming format is tool calls: they arrive as
 * *fragments* keyed by an array index, with the name in the first chunk and the
 * JSON arguments dribbling in across many later chunks. We accumulate them into
 * a dense array and emit whole ToolCalls at the end.
 * OpenAI 流式格式最麻烦的是工具调用：它们按数组下标分片到达，名字在首个分片，
 * JSON 参数则零散分布在后续众多分片中。我们累积成密集数组，最后一次性产出完整 ToolCall。
 */
export async function* streamAssistantTurn(
  params: StreamParams,
): AsyncGenerator<StreamEvent, void> {
  const { messages, tools, settings, signal } = params
  const client = getClient(settings)

  yield { type: 'request_start' }

  const stream = await client.chat.completions.create(
    {
      model: settings.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools?.length ? { tools, tool_choice: 'auto' as const } : {}),
    },
    { signal },
  )

  let text = ''
  const partials: { id: string; name: string; arguments: string }[] = []
  let usage: Usage | undefined

  for await (const chunk of stream) {
    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
      }
    }

    const delta = chunk.choices[0]?.delta
    if (!delta) continue

    if (delta.content) {
      text += delta.content
      yield { type: 'text_delta', text: delta.content }
    }

    for (const fragment of delta.tool_calls ?? []) {
      const slot = (partials[fragment.index] ??= { id: '', name: '', arguments: '' })
      if (fragment.id) slot.id = fragment.id
      if (fragment.function?.name) slot.name += fragment.function.name
      if (fragment.function?.arguments) slot.arguments += fragment.function.arguments
    }
  }

  const toolCalls: ToolCall[] = partials
    .filter(slot => slot && slot.name)
    .map((slot, index) => ({
      id: slot.id || `call_${index}`,
      name: slot.name,
      arguments: slot.arguments || '{}',
    }))

  yield { type: 'done', text, toolCalls, usage }
}
