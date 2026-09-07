import type { Settings } from './utils/config.js'
import type { Message, ToolCall } from './types/message.js'
import { toApiMessages } from './types/message.js'
import { streamAssistantTurn, type Usage } from './services/api/stream.js'
import { toApiTools, type Tool, type ToolContext } from './Tool.js'

/**
 * THE AGENT LOOP.
 * 代理主循环。
 *
 * Everything else in mini-cc is scaffolding around this function.
 * mini-cc 的其余部分都只是围绕这个函数的脚手架。
 *
 *   1. Send the message list to the model, with the tool schemas.
 *   2. Stream the reply.
 *   3. No tool calls?  -> the turn is over. Return why.
 *   4. Tool calls?     -> run them, append the results, go to 1.
 *   1. 把消息列表连同工具 schema 发给模型。
 *   2. 流式接收回复。
 *   3. 没有工具调用？-> 回合结束，返回原因。
 *   4. 有工具调用？  -> 执行、追加结果，回到第 1 步。
 *
 * It is an *async generator*: it YIELDS events during the turn so the UI can
 * render incrementally, and RETURNS a Terminal at the end so the caller learns
 * precisely why it stopped.
 * 它是异步生成器：回合中 yield 事件供 UI 增量渲染，结束时 return 一个 Terminal，
 * 让调用方确切知道为何停止。
 *
 * cf. src/query.ts in the Claude Code tree, which names 11 terminal reasons and
 * 7 continue reasons. The principle there is worth internalising: recovery is a
 * loop transition, not an exception. Context overflow and truncated output are
 * *continues*; only genuine dead ends terminate.
 * 参见 Claude Code 的 src/query.ts：列举 11 种终止原因与 7 种继续原因。其原则值得内化——
 * 恢复是循环状态转移，而非异常。上下文溢出、输出截断都属于「继续」，只有真正的死路才终止。
 */

export type Terminal =
  | { reason: 'completed'; turns: number }
  | { reason: 'max_turns'; turns: number }
  | { reason: 'aborted'; turns: number }
  | { reason: 'model_error'; turns: number; error: string }

export type QueryEvent =
  | { type: 'request_start'; turn: number }
  | { type: 'text_delta'; text: string }
  | { type: 'assistant_message'; message: Message; usage?: Usage }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_end'; call: ToolCall; result: string; isError: boolean }

export type QueryParams = {
  /**
   * Mutated in place, so the caller keeps the full transcript.
   * 就地修改，使调用方持有完整会话记录。
   */
  messages: Message[]
  settings: Settings
  tools: Tool[]
  toolContext: ToolContext
  maxTurns?: number
}

export async function* query(params: QueryParams): AsyncGenerator<QueryEvent, Terminal> {
  const { messages, settings, tools, toolContext } = params
  const maxTurns = params.maxTurns ?? settings.maxTurns
  const signal = toolContext.abortController.signal

  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const apiTools = toApiTools(tools)

  let turn = 0

  while (true) {
    if (signal.aborted) return { reason: 'aborted', turns: turn }

    turn += 1
    if (turn > maxTurns) return { reason: 'max_turns', turns: turn - 1 }

    yield { type: 'request_start', turn }

    // --- 1 & 2: call the model and stream the reply -------------------------
    // --- 第 1、2 步：调用模型并流式接收回复 ---
    let text = ''
    let toolCalls: ToolCall[] = []
    let usage: Usage | undefined

    try {
      for await (const event of streamAssistantTurn({
        messages: toApiMessages(messages),
        tools: apiTools,
        settings,
        signal,
      })) {
        if (event.type === 'text_delta') {
          yield { type: 'text_delta', text: event.text }
        } else if (event.type === 'done') {
          text = event.text
          toolCalls = event.toolCalls
          usage = event.usage
        }
      }
    } catch (error) {
      if (signal.aborted) return { reason: 'aborted', turns: turn }
      return {
        reason: 'model_error',
        turns: turn,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    const assistantMessage: Message = {
      role: 'assistant',
      content: text,
      ...(toolCalls.length ? { toolCalls } : {}),
    }
    messages.push(assistantMessage)
    yield { type: 'assistant_message', message: assistantMessage, usage }

    // --- 3: no tool calls means the turn is over ----------------------------
    // --- 第 3 步：没有工具调用即回合结束 ---
    //
    // Note we test for the *presence of tool calls*, not `finish_reason`.
    // Providers disagree about finish_reason; the blocks are the ground truth.
    // 注意判断依据是「是否存在工具调用」，而非 finish_reason：
    // 各家供应商对 finish_reason 的处理不一致，调用块才是事实依据。
    if (toolCalls.length === 0) {
      return { reason: 'completed', turns: turn }
    }

    // --- 4: run the tools and feed the results back ------------------------
    // --- 第 4 步：执行工具并把结果回灌 ---
    //
    // Serial for now. Chapter 14 adds a batch scheduler that runs
    // concurrency-safe calls in parallel while preserving relative order.
    // 目前串行。第 14 章加入批调度器，在保持相对顺序的前提下并行执行并发安全的调用。
    for (const call of toolCalls) {
      if (signal.aborted) {
        // Every tool_use MUST get a tool_result or the next request is
        // malformed, so we synthesise error results for the rest.
        // 每个 tool_use 必须有对应的 tool_result，否则下一次请求格式非法，
        // 因此为剩余调用合成错误结果。
        for (const pending of toolCalls.slice(toolCalls.indexOf(call))) {
          messages.push({
            role: 'tool',
            toolCallId: pending.id,
            content: 'Interrupted by user',
            isError: true,
          })
        }
        return { reason: 'aborted', turns: turn }
      }

      yield { type: 'tool_start', call }
      const { result, isError } = await runOneTool(call, byName, toolContext)
      messages.push({ role: 'tool', toolCallId: call.id, content: result, isError })
      yield { type: 'tool_end', call, result, isError }
    }
  }
}

/**
 * Run a single tool call. A failing tool is NOT an exception at the loop level:
 * the error text goes back to the model as a tool result so it can correct
 * itself. A crashed loop helps nobody.
 * 执行单次工具调用。工具失败在循环层面不算异常：错误文本作为工具结果回传给模型，
 * 让它自行纠正。循环崩溃对谁都没好处。
 */
async function runOneTool(
  call: ToolCall,
  byName: Map<string, Tool>,
  ctx: ToolContext,
): Promise<{ result: string; isError: boolean }> {
  const tool = byName.get(call.name)
  if (!tool) {
    return {
      result: `Error: no tool named ${call.name}. Available: ${[...byName.keys()].join(', ')}`,
      isError: true,
    }
  }

  let input: unknown
  try {
    input = JSON.parse(call.arguments || '{}')
  } catch {
    return {
      result: `Error: arguments for ${call.name} were not valid JSON:\n${call.arguments}`,
      isError: true,
    }
  }

  try {
    return { result: await tool.execute(input, ctx), isError: false }
  } catch (error) {
    return {
      result: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    }
  }
}
