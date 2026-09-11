// 本文件：流式请求层，把 OpenAI 的分片响应累积成文本增量与完整的工具调用。
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
// 本函数：流式请求一次助手回合，过程中产出文本增量，结束时给出完整文本、工具调用与用量。
// 整体流程：1 取客户端并发起流式请求 → 2 逐分片处理：记 usage、累积并 yield 文本增量、
//          按 index 累积工具调用分片 → 3 流结束后把分片合成完整 ToolCall
//          → 4 以一条 'done' 事件交出完整文本、工具调用与用量。
export async function* streamAssistantTurn(
  params: StreamParams,
): AsyncGenerator<StreamEvent, void> {
  const { messages, tools, settings, signal } = params
  const client = getClient(settings)

  yield { type: 'request_start' }

  // 步骤 1：发起流式请求。
  const stream = await client.chat.completions.create(
    {
      model: settings.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },  // 流式默认不回传 usage，显式开启后会在最后一个分片里附上真实 token 数，用来校正我们的估算
      ...(tools?.length ? { tools, tool_choice: 'auto' as const } : {}),  // 无工具时连字段都不发：部分供应商见到空的 tools 数组会直接报错
    },
    { signal },
  )

  let text = ''
  const partials: { id: string; name: string; arguments: string }[] = []
  let usage: Usage | undefined

  // 步骤 2：逐分片消费。
  for await (const chunk of stream) {
    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
      }
    }

    const delta = chunk.choices[0]?.delta
    if (!delta) continue  // 携带 usage 的收尾分片没有 choices，跳过即可，别误当成流结束

    if (delta.content) {
      text += delta.content  // 一边累积完整文本供 'done' 使用，一边把增量 yield 出去让 UI 逐字渲染
      yield { type: 'text_delta', text: delta.content }
    }

    for (const fragment of delta.tool_calls ?? []) {
      const slot = (partials[fragment.index] ??= { id: '', name: '', arguments: '' })  // 按分片自带的 index 定位槽位，没有就地新建：分片可能乱序到达，靠下标而非到达顺序归位
      if (fragment.id) slot.id = fragment.id
      if (fragment.function?.name) slot.name += fragment.function.name
      if (fragment.function?.arguments) slot.arguments += fragment.function.arguments  // 参数是逐片拼接的 JSON 文本，拼完才是一个完整对象，因此中途不能解析
    }
  }

  // 步骤 3：把累积的分片槽位合成完整的 ToolCall。
  const toolCalls: ToolCall[] = partials
    .filter(slot => slot && slot.name)  // partials 按下标赋值可能留下空洞，故先滤掉空槽与没拿到名字的残片
    .map((slot, index) => ({
      id: slot.id || `call_${index}`,  // 个别供应商不回传 id，用下标兜底，保证每个调用都有唯一 id 与之配对结果
      name: slot.name,
      arguments: slot.arguments || '{}',
    }))

  // 步骤 4：交出终态。调用方只从这一条事件里取完整结果。
  yield { type: 'done', text, toolCalls, usage }
}
