// 本文件：工具调用的编排——决定哪些调用可以并行、以何种并发度执行，以及为子代理派生子上下文。
import type { ToolCall } from '../../types/message.js'
import type { Tool, ToolContext } from '../../Tool.js'

/**
 * Deciding which tool calls may run at the same time.
 * 决定哪些工具调用可以同时执行。
 *
 * The rule is one line: group CONSECUTIVE concurrency-safe calls into one
 * parallel batch; anything else becomes a batch of one.
 * 规则只有一句：把「相邻的」并发安全调用合成一个并行批次，其余各自单独成批。
 *
 * "Consecutive" is what makes it correct. If the model asks for
 * 「相邻」正是正确性的来源。若模型请求：
 *
 *   Read(a)  Read(b)  Edit(a)  Read(a)
 *
 * you may run the first two together, but the last Read must not overtake the
 * Edit — it would read stale content. Grouping only adjacent safe calls
 * preserves relative order for free, with no dependency analysis.
 * 前两个可并行，但最后的 Read 不能越过 Edit——否则读到陈旧内容。
 * 只合并相邻的安全调用，天然保住相对顺序，无需做依赖分析。
 *
 * cf. partitionToolCalls in src/services/tools/toolOrchestration.ts — 195
 * lines, fully self-contained, and worth reading in full.
 * 参见 src/services/tools/toolOrchestration.ts 的 partitionToolCalls——195 行、完全自洽，值得通读。
 */

export const DEFAULT_MAX_CONCURRENCY = 10

export type ToolBatch = {
  calls: ToolCall[]
  parallel: boolean
}

/**
 * Concurrency is a property of the CALL, not of the tool: `Bash(git status)`
 * is safe, `Bash(npm install)` is not.
 * 并发性属于「本次调用」而非工具本身：`Bash(git status)` 安全，`Bash(npm install)` 不安全。
 *
 * If the check throws — bad arguments, a schema mismatch — we fail CLOSED and
 * treat the call as unsafe. An exception must never widen what is allowed.
 * 检查过程若抛错（参数非法、schema 不匹配），一律「失败即关闭」按不安全处理。
 * 异常绝不能扩大放行范围。
 */
// 本函数：判断单次工具调用是否并发安全，出错时按不安全处理。
function isSafe(call: ToolCall, byName: Map<string, Tool>): boolean {
  const tool = byName.get(call.name)
  if (!tool) return false
  try {
    const parsed = tool.inputSchema.safeParse(JSON.parse(call.arguments || '{}'))  // 先解析入参才能问「这次调用安不安全」——并发性看的是参数，不是工具本身
    if (!parsed.success) return false
    return tool.isConcurrencySafe?.(parsed.data) ?? false  // 工具没声明就按不安全处理，于是新写的工具默认串行，不会悄悄获得并发资格
  } catch {
    return false
  }
}

// 本函数：把一串工具调用切成批次——相邻的并发安全调用合成并行批，其余单独成批。
export function partitionToolCalls(calls: ToolCall[], byName: Map<string, Tool>): ToolBatch[] {
  const batches: ToolBatch[] = []

  for (const call of calls) {
    const safe = isSafe(call, byName)
    const last = batches.at(-1)

    if (safe && last?.parallel) {  // 只有「当前调用安全」且「上一批也是并行批」才并入，于是合并的必然是相邻的安全调用
      last.calls.push(call)
    } else {
      batches.push({ calls: [call], parallel: safe })
    }
  }

  return batches
}

/** Run `tasks` with at most `limit` in flight, preserving result order. */
/** 以最多 `limit` 个并发执行 `tasks`，并保持结果顺序。 */
// 本函数：带上限的并发执行器，结果按任务原顺序返回。
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0

  // 本函数：工作协程，不断领取下一个任务索引直到取完。
  async function worker(): Promise<void> {
    while (true) {
      const index = next++  // 多个 worker 共享同一个游标领取任务；JS 单线程执行到此不会被打断，故自增是安全的
      if (index >= tasks.length) return
      results[index] = await tasks[index]!()  // 按任务原下标回填结果，因此完成先后不影响返回顺序
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()))  // 启动 min(上限, 任务数) 个 worker，即并发度；任务少于上限时不空转
  return results
}

// 本函数：读取并发上限（环境变量 MINI_CC_MAX_TOOL_CONCURRENCY），非法值回退到默认值。
export function maxConcurrency(): number {
  const raw = Number(process.env.MINI_CC_MAX_TOOL_CONCURRENCY)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_CONCURRENCY  // 未设置时 Number(undefined) 得 NaN，非法值与 0、负数一并被这行滤回默认值
}

/**
 * A child context for a sub-agent.
 * 子代理的子上下文。
 *
 * The whole "sub-agent" concept is this function plus a recursive query()
 * call. What changes:
 * 所谓「子代理」，就是这个函数加上一次递归的 query() 调用。变化的部分：
 *
 *   - its own AbortController, so a failing sub-agent does not kill the parent
 *     turn (and Esc still reaches it, because we forward the parent's abort)
 *   - its own readFileState, so its reads do not license the parent to edit
 *   - an agentId, which is how todos and hooks tell them apart
 *   - 自己的 AbortController：子代理出错不会终结父回合；同时转发父级 abort，Esc 依然能中断它
 *   - 自己的 readFileState：它的读取不能给父级充当「已读」凭据
 *   - 一个 agentId：待办清单与钩子据此区分不同代理
 *
 * What is SHARED: permissions and fileHistory. A sub-agent must not be able to
 * escape the gate, and its edits must still be undoable by /rewind.
 * 共享的部分：permissions 与 fileHistory。子代理不得绕过权限闸门，其改动也必须能被 /rewind 撤销。
 */
// 本函数：由父上下文派生子代理上下文——独立的中断控制与读取状态，共享权限与文件历史。
export function createSubagentContext(parent: ToolContext, agentId: string): ToolContext {
  const abortController = new AbortController()
  parent.abortController.signal.addEventListener(  // 父级中断向下转发到子代理；反向不转发，故子代理失败不会连累父回合
    'abort',
    () => abortController.abort(parent.abortController.signal.reason),
    { once: true },
  )

  return {
    ...parent,
    abortController,
    readFileState: new Map(),
    sessionAllow: new Set(parent.sessionAllow),  // 复制而非共享：子代理继承此刻的「总是允许」，但它的新增授权不会回流给父级
    agentId,
  }
}
