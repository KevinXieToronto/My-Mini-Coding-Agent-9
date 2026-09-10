// 本文件：代理主循环所在处，驱动「调用模型 → 执行工具 → 回灌结果」的回合迭代。
import type { z } from 'zod'
import type { Settings } from './utils/config.js'
import type { ApiMessage, Message, ToolCall } from './types/message.js'
import { toApiMessages } from './types/message.js'
import { streamAssistantTurn, type Usage } from './services/api/stream.js'
import { toApiTools, type PermissionResult, type Tool, type ToolContext } from './Tool.js'
import { evaluatePermission } from './utils/permissions.js'
import { tokenState } from './utils/tokens.js'
import { compactConversation } from './services/compact/compact.js'
import { runContextHooks, runPreToolUseHooks, runStopHooks } from './utils/hooks.js'
import {
  partitionToolCalls,
  runWithConcurrency,
  maxConcurrency,
} from './services/tools/toolOrchestration.js'

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
  | { type: 'compacted'; tokensBefore: number; tokensAfter: number; method: string }
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
  /**
   * Prepended as a system message on every request. See src/context.ts.
   * 每次请求前置为一条 system 消息。参见 src/context.ts。
   */
  systemPrompt?: string
  maxTurns?: number
  /** Set false to disable auto-compaction (Ch.11). */
  /** 置为 false 可关闭自动压缩（第 11 章）。 */
  autoCompact?: boolean
  /**
   * Asks the human. Called only when the gate returns 'ask'. Returning false
   * denies the call — which becomes a tool_result, not an exception, so the
   * model can choose a different approach.
   * 询问人类。仅当闸门返回 'ask' 时调用。返回 false 即拒绝该调用——
   * 拒绝会变成一条 tool_result 而非异常，模型因此可以改用别的办法。
   */
  canUseTool: CanUseTool
  /**
   * Called for every message appended to the history, in order. This is the
   * persistence seam: the loop does not know what a transcript is.
   * 每条追加进历史的消息都会按序回调。这是持久化的接缝：循环本身不知道会话记录为何物。
   */
  onMessage?: (message: Message) => void
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
  const { messages, settings, tools, toolContext, systemPrompt, canUseTool } = params
  const maxTurns = params.maxTurns ?? settings.maxTurns
  const signal = toolContext.abortController.signal
  const onMessage = params.onMessage ?? (() => {})

  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const apiTools = toApiTools(tools)

  let turn = 0
  // A Stop hook may re-open the turn, but only once — see below.
  // Stop 钩子可以让回合重开，但只允许一次——见下文。
  let stopHookFired = false

  while (true) {
    if (signal.aborted) return { reason: 'aborted', turns: turn }

    turn += 1
    if (turn > maxTurns) return { reason: 'max_turns', turns: turn - 1 }

    // --- 0: keep the context inside the window ---------------------------
    // --- 第 0 步：把上下文压回窗口以内 ---
    //
    // This is the fourth design principle from ARCHITECTURE.md made concrete:
    // recovery is a LOOP TRANSITION, not an exception. Running out of room is
    // something the loop handles and continues from, not something that ends
    // the turn.
    // 这是 ARCHITECTURE.md 第四条设计原则的落地：恢复是循环状态转移，而非异常。
    // 空间不够由循环自行处理并继续，而不是就此结束回合。
    if (params.autoCompact !== false) {
      const state = tokenState(messages, systemPrompt ?? '', settings.model)  // 每回合开头先估算用量，压缩发生在请求之前而不是收到 400 之后
      if (state.shouldCompact) {
        const result = await compactConversation(messages, settings, signal)
        // Replace the caller's array IN PLACE: it is the same array the REPL
        // and the session writer hold references to.
        // 就地替换调用方的数组：REPL 与会话写入器持有的是同一个数组引用。
        messages.splice(0, messages.length, ...result.messages)  // 就地清空再填回，保证 REPL 与会话写入器持有的同一数组引用同步看到压缩结果
        yield {
          type: 'compacted',
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          method: result.method,
        }
      }
    }

    yield { type: 'request_start', turn }

    // --- 1 & 2: call the model and stream the reply -------------------------
    // --- 第 1、2 步：调用模型并流式接收回复 ---
    let text = ''
    let toolCalls: ToolCall[] = []
    let usage: Usage | undefined

    try {
      for await (const event of streamAssistantTurn({
        messages: withSystemPrompt(toApiMessages(messages), systemPrompt),
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
    onMessage(assistantMessage)
    yield { type: 'assistant_message', message: assistantMessage, usage }

    // --- 3: no tool calls means the turn is over ----------------------------
    // --- 第 3 步：没有工具调用即回合结束 ---
    //
    // Note we test for the *presence of tool calls*, not `finish_reason`.
    // Providers disagree about finish_reason; the blocks are the ground truth.
    // 注意判断依据是「是否存在工具调用」，而非 finish_reason：
    // 各家供应商对 finish_reason 的处理不一致，调用块才是事实依据。
    if (toolCalls.length === 0) {
      // Stop hooks get the last word. One may decide the work is not actually
      // finished — "the tests still fail" — and push the loop around again.
      // This is a CONTINUE, not an error: the same principle as compaction.
      // Stop 钩子有最终发言权：它可以判定活儿其实没干完（「测试还挂着」），
      // 把循环再推一圈。这属于「继续」而非错误，与压缩同一条原则。
      const stop = await runStopHooks(
        toolContext.hooks,
        { hook_event_name: 'Stop', session_id: toolContext.sessionId, cwd: toolContext.cwd },
        toolContext.cwd,
      )
      if (stop.keepGoing && !stopHookFired) {
        stopHookFired = true // once per turn, or a badly written hook loops forever
        // 每个用户回合（即每次 query() 调用）只放行一次，否则写坏的钩子会让循环永不停歇
        const nudge: Message = { role: 'user', content: `[Stop hook] ${stop.reason}` }
        messages.push(nudge)
        onMessage(nudge)
        continue
      }
      return { reason: 'completed', turns: turn }
    }

    // --- 4: run the tools and feed the results back ------------------------
    // --- 第 4 步：执行工具并把结果回灌 ---
    //
    // Consecutive concurrency-safe calls run in parallel; everything else runs
    // alone. Grouping only ADJACENT safe calls preserves relative order, so a
    // Read can never overtake an Edit to the same file.
    // 相邻的并发安全调用并行执行，其余单独执行。只合并「相邻」的安全调用即可保住相对顺序，
    // 因此 Read 永远不会越过对同一文件的 Edit。
    const batches = partitionToolCalls(toolCalls, byName)

    for (const batch of batches) {
      if (signal.aborted) {
        // Every tool_use MUST get a tool_result or the next request is
        // malformed, so we synthesise error results for everything left.
        // 每个 tool_use 必须有对应的 tool_result，否则下一次请求格式非法，
        // 因此为所有尚未应答的调用合成错误结果。
        const answered = new Set(  // 先统计已经有 tool_result 的调用 id，避免给同一个调用补发第二条结果
          messages.flatMap(message => (message.role === 'tool' ? [message.toolCallId] : [])),
        )
        for (const pending of toolCalls) {
          if (answered.has(pending.id)) continue
          const interrupted: Message = {
            role: 'tool',
            toolCallId: pending.id,
            content: 'Interrupted by user',
            isError: true,
          }
          messages.push(interrupted)
          onMessage(interrupted)
        }
        return { reason: 'aborted', turns: turn }
      }

      for (const call of batch.calls) yield { type: 'tool_start', call }

      const outcomes = batch.parallel
        ? await runWithConcurrency(
            batch.calls.map(call => () => runOneTool(call, byName, toolContext, canUseTool)),
            maxConcurrency(),
          )
        : [await runOneTool(batch.calls[0]!, byName, toolContext, canUseTool)]

      for (const [index, outcome] of outcomes.entries()) {
        const call = batch.calls[index]!
        const toolMessage: Message = {
          role: 'tool',
          toolCallId: call.id,
          content: outcome.result,
          isError: outcome.isError,
        }
        messages.push(toolMessage)
        onMessage(toolMessage)
        yield { type: 'tool_end', call, result: outcome.result, isError: outcome.isError }
      }
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
  const parsed = tool.inputSchema.safeParse(raw)  // strictObject 会连未知字段一并拒绝，能拦下模型「多写一个参数」这类常见失误
  if (!parsed.success) {
    return {
      result: `InputValidationError: ${call.name} arguments are invalid.\n${formatZodError(parsed.error)}`,
      isError: true,
    }
  }

  const validation = tool.validateInput?.(parsed.data, ctx)
  if (validation && !validation.ok) {
    return { result: `Error: ${validation.message}`, isError: true }
  }

  // PreToolUse hooks run BEFORE the gate, and can deny outright or rewrite
  // the input. A hook that denies wins over any allow rule — hooks subtract.
  // PreToolUse 钩子在闸门之前运行，可直接拒绝、也可改写入参。
  // 钩子的拒绝压过任何 allow 规则——钩子做的是减法。
  let input = parsed.data
  const pre = await runPreToolUseHooks(
    ctx.hooks,
    {
      hook_event_name: 'PreToolUse',
      session_id: ctx.sessionId,
      cwd: ctx.cwd,
      tool_name: tool.name,
      tool_input: input,
    },
    ctx.cwd,
  )
  if (pre.decision === 'deny') {
    return { result: `PermissionDenied: ${pre.reason ?? 'blocked by a hook'}`, isError: true }
  }
  if (pre.updatedInput) {
    // Re-validate: a hook is not trusted to produce a well-formed input.
    // 重新校验：钩子并不被信任能产出格式良好的入参。
    const reparsed = tool.inputSchema.safeParse(pre.updatedInput)  // 钩子改写后的入参重新过一遍 schema，校验不通过就丢弃改写、沿用原入参
    if (reparsed.success) input = reparsed.data
  }

  // THE GATE. Everything above this line was validation; this is authorisation.
  // 闸门。此线之上都是「校验」，这里才是「授权」。
  const decision: PermissionResult =
    pre.decision === 'allow'
      ? { behavior: 'allow' }
      : evaluatePermission(tool, input, ctx)
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

    // PostToolUse hooks cannot undo the call — it already happened — but they
    // can append context. This is where a formatter or a linter runs.
    // PostToolUse 钩子无法撤销这次调用（它已经发生了），但可以追加上下文。
    // 格式化器、linter 就跑在这里。
    const post = await runContextHooks(
      ctx.hooks,
      'PostToolUse',
      {
        hook_event_name: 'PostToolUse',
        session_id: ctx.sessionId,
        cwd: ctx.cwd,
        tool_name: tool.name,
        tool_input: input,
        tool_response: output.result,
      },
      ctx.cwd,
    )

    return {
      result: post.additionalContext
        ? `${output.result}

<hook-context>
${post.additionalContext}
</hook-context>`
        : output.result,
      isError: false,
    }
  } catch (error) {
    return {
      result: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    }
  }
}

/**
 * The system prompt is not part of the message history we persist — it is
 * rebuilt on every request. Keeping it out of `messages` means compaction
 * (Ch.11) can never accidentally summarise away the agent's instructions.
 * 系统提示词不属于我们持久化的消息历史，而是每次请求重新拼装。
 * 把它排除在 `messages` 之外，压缩（第 11 章）就绝不会误把代理的指令摘要掉。
 */
// 本函数：把系统提示词作为一条 system 消息前置到请求消息列表，而不写入持久化的会话记录。
function withSystemPrompt(messages: ApiMessage[], systemPrompt?: string): ApiMessage[] {
  if (!systemPrompt) return messages
  return [{ role: 'system', content: systemPrompt }, ...messages]
}

// 本函数：把 zod 校验错误格式化成模型易读的多行提示。
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map(issue => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
}
