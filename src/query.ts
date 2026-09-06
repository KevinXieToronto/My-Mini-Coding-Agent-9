import type { Settings } from './utils/config.js'
import type { Message, ToolCall } from './types/message.js'
import { toApiMessages } from './types/message.js'
import { streamAssistantTurn, type Usage } from './services/api/stream.js'
import { toApiTools, type Tool, type ToolContext } from './Tool.js'

/**
 * THE AGENT LOOP.
 *
 * Everything else in mini-cc is scaffolding around this function.
 *
 *   1. Send the message list to the model, with the tool schemas.
 *   2. Stream the reply.
 *   3. No tool calls?  -> the turn is over. Return why.
 *   4. Tool calls?     -> run them, append the results, go to 1.
 *
 * It is an *async generator*: it YIELDS events during the turn so the UI can
 * render incrementally, and RETURNS a Terminal at the end so the caller learns
 * precisely why it stopped.
 *
 * cf. src/query.ts in the Claude Code tree, which names 11 terminal reasons and
 * 7 continue reasons. The principle there is worth internalising: recovery is a
 * loop transition, not an exception. Context overflow and truncated output are
 * *continues*; only genuine dead ends terminate.
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
  /** Mutated in place, so the caller keeps the full transcript. */
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
    //
    // Note we test for the *presence of tool calls*, not `finish_reason`.
    // Providers disagree about finish_reason; the blocks are the ground truth.
    if (toolCalls.length === 0) {
      return { reason: 'completed', turns: turn }
    }

    // --- 4: run the tools and feed the results back ------------------------
    //
    // Serial for now. Chapter 14 adds a batch scheduler that runs
    // concurrency-safe calls in parallel while preserving relative order.
    for (const call of toolCalls) {
      if (signal.aborted) {
        // Every tool_use MUST get a tool_result or the next request is
        // malformed, so we synthesise error results for the rest.
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
