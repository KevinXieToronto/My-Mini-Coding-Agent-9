// 本文件：代理主循环所在处，驱动「调用模型 → 执行工具 → 回灌结果」的回合迭代。
import type { z } from 'zod'
import type { Settings } from './utils/config.js'
import type { Message, ToolCall } from './types/message.js'
import { toApiMessages } from './types/message.js'
import { streamAssistantTurn, type Usage } from './services/api/stream.js'
import { toApiTools, type PermissionResult, type Tool, type ToolContext } from './Tool.js'
import { evaluatePermission } from './utils/permissions.js'

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
  /**
   * Asks the human. Called only when the gate returns 'ask'. Returning false
   * denies the call — which becomes a tool_result, not an exception, so the
   * model can choose a different approach.
   * 询问人类。仅当闸门返回 'ask' 时调用。返回 false 即拒绝该调用——
   * 拒绝会变成一条 tool_result 而非异常，模型因此可以改用别的办法。
   */
  canUseTool: CanUseTool
}

/**
 * The callback the UI supplies to answer an approval prompt.
 * UI 提供的回调，用于回答批准询问。
 */
export type CanUseTool = (request: {
  tool: Tool
  input: unknown
  message: string
}) => Promise<boolean>

// 本函数：代理主循环——反复请求模型并执行其工具调用，直到没有工具调用或触发终止条件。
export async function* query(params: QueryParams): AsyncGenerator<QueryEvent, Terminal> {
  const { messages, settings, tools, toolContext, canUseTool } = params
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
      const { result, isError } = await runOneTool(call, byName, toolContext, canUseTool)
      messages.push({ role: 'tool', toolCallId: call.id, content: result, isError })
      yield { type: 'tool_end', call, result, isError }
    }
  }
}

/**
 * Run a single tool call through the pipeline:
 * 让单次工具调用走完整条流水线：
 *
 *   lookup -> JSON parse -> schema parse -> validateInput -> execute
 *   查表 -> 解析 JSON -> 解析 schema -> validateInput -> execute
 *
 * Every failure returns a MESSAGE, never an exception. The model reads the
 * error, corrects itself, and tries again. Validation runs before permissions
 * (Ch.6) so a malformed call fails fast without spending a human interruption.
 * 任何失败都返回「消息」而非抛异常：模型读到错误、自行纠正、重试。
 * 校验先于权限检查（第 6 章），让非法调用尽早失败，不必打扰人类。
 *
 * cf. checkPermissionsAndCallTool in src/services/tools/toolExecution.ts.
 * 参见 src/services/tools/toolExecution.ts 的 checkPermissionsAndCallTool。
 */
// 本函数：让单次工具调用走完「查表 → 解析 JSON → 校验 schema → validateInput → execute」，任何失败都以错误文本返回而非抛异常。
async function runOneTool(
  call: ToolCall,
  byName: Map<string, Tool>,
  ctx: ToolContext,
  canUseTool: CanUseTool,
): Promise<{ result: string; isError: boolean }> {
  const tool = byName.get(call.name)
  if (!tool) {
    return {
      result: `Error: no tool named ${call.name}. Available: ${[...byName.keys()].join(', ')}`,
      isError: true,
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(call.arguments || '{}')
  } catch {
    return {
      result: `Error: arguments for ${call.name} were not valid JSON:\n${call.arguments}`,
      isError: true,
    }
  }

  // The schema is the first wall. strictObject rejects unknown keys, which
  // catches a surprising number of model mistakes.
  // schema 是第一道墙。strictObject 拒绝未知字段，能拦下相当多的模型失误。
  const parsed = tool.inputSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      result: `InputValidationError: ${call.name} arguments are invalid.\n${formatZodError(parsed.error)}`,
      isError: true,
    }
  }
  const input = parsed.data

  const validation = tool.validateInput?.(input, ctx)
  if (validation && !validation.ok) {
    return { result: `Error: ${validation.message}`, isError: true }
  }

  // THE GATE. Everything above this line was validation; this is authorisation.
  // 闸门。此线之上都是「校验」，这里才是「授权」。
  const decision: PermissionResult = evaluatePermission(tool, input, ctx)
  if (decision.behavior === 'deny') {
    return { result: `PermissionDenied: ${decision.message}`, isError: true }
  }
  if (decision.behavior === 'ask') {
    const approved = await canUseTool({ tool, input, message: decision.message })
    if (!approved) {
      return {
        result:
          'PermissionDenied: the user declined this action. ' +
          'Do not retry it. Explain what you wanted to do, or propose an alternative.',
        isError: true,
      }
    }
  }

  try {
    const output = await tool.execute(input, ctx)
    return { result: output.result, isError: false }
  } catch (error) {
    return {
      result: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    }
  }
}

// 本函数：把 zod 校验错误格式化成模型易读的多行提示。
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map(issue => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
}
