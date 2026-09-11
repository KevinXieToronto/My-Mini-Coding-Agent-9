// 本文件：Agent 工具——把一项自洽任务委派给拥有独立上下文窗口的子代理（同一个 query 循环）。
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { buildTool, type Tool } from '../Tool.js'
import { createSubagentContext } from '../services/tools/toolOrchestration.js'
import type { Message } from '../types/message.js'

/**
 * Tools a sub-agent may never have.
 * 子代理绝不可拥有的工具。
 *
 * Agent is excluded to stop unbounded recursion. ExitPlanMode is excluded
 * because a sub-agent has no user to approve a plan.
 * 排除 Agent 以阻止无限递归；排除 ExitPlanMode 是因为子代理没有可批准计划的用户。
 */
const DISALLOWED_FOR_SUBAGENTS = new Set(['Agent', 'ExitPlanMode'])

const schema = z.strictObject({
  description: z.string().describe('A 3-5 word summary, shown to the user while it runs.'),
  prompt: z
    .string()
    .describe(
      'The task, written for an agent that has NO memory of this conversation. ' +
        'State the goal, the constraints, and exactly what to report back.',
    ),
  subagent_type: z
    .enum(['explore', 'general'])
    .optional()
    .describe('explore = read-only investigation (default). general = may also make changes.'),
})

const AGENT_PROMPTS = {
  explore: `You are a read-only research sub-agent.

Investigate and report. You cannot modify anything, and you should not try.
Your caller cannot see your work — only your final message — so that message
must stand alone: name the files and line numbers you found, quote the few
lines that matter, and answer the question you were asked. Do not describe
your search process.`,

  general: `You are a sub-agent working on one focused task.

You have the same tools as your caller, minus the ability to spawn further
sub-agents. Your caller cannot see your work — only your final message — so
report what you did, what you changed, and anything the caller needs to know
that they did not ask about.`,
} as const

export type AgentToolDeps = {
  /**
   * Injected to break a cycle: query.ts imports the registry, the registry
   * imports this tool, and this tool needs query(). Passing it in keeps the
   * import graph acyclic and makes the sub-agent loop testable with a fake.
   * 注入以打破循环：query.ts 引用注册表、注册表引用本工具、本工具又需要 query()。
   * 由外部传入既保持导入图无环，也让子代理循环可用假实现测试。
   */
  runNestedQuery: (params: {
    messages: Message[]
    tools: Tool[]
    systemPrompt: string
    ctx: ReturnType<typeof createSubagentContext>
    maxTurns: number
  }) => Promise<{ text: string; turns: number }>
  getTools: () => Tool[]
}

/**
 * Spawn a nested agent loop.
 * 派生一个嵌套的代理循环。
 *
 * The whole idea in one sentence: a sub-agent is THE SAME query() loop with a
 * different context object and a restricted tool list. There is no separate
 * engine.
 * 一句话概括：子代理就是换了 context 对象、限制了工具清单的同一个 query() 循环，没有第二套引擎。
 *
 * Why bother? CONTEXT ISOLATION. "Find every place we validate an email
 * address" might read forty files. Done inline, those forty file contents are
 * in the parent's context window forever. Delegated, the parent gets three
 * sentences and the forty reads are discarded with the sub-agent.
 * 为什么值得？上下文隔离。「找出所有校验邮箱的地方」可能要读四十个文件：
 * 内联执行会让这四十份内容永久占据父级上下文；委派出去，父级只得到三句话，
 * 四十次读取随子代理一起被丢弃。
 *
 * cf. src/tools/AgentTool/ — AgentTool.tsx, runAgent.ts, loadAgentsDir.ts.
 * 参见 src/tools/AgentTool/ 目录：AgentTool.tsx、runAgent.ts、loadAgentsDir.ts。
 */
// 本函数：构造 Agent 工具实例；循环由外部注入，以避免循环依赖。
export function createAgentTool(deps: AgentToolDeps) {
  return buildTool({
    name: 'Agent',
    description:
      'Delegate a self-contained task to a sub-agent with its own context window. ' +
      'Use this when answering would mean reading many files and you only need the ' +
      'conclusion — the sub-agent reads them, you get the summary, and their reads ' +
      'never enter your context. The sub-agent cannot ask you questions and cannot ' +
      'see this conversation, so the prompt must be complete on its own. ' +
      'Do NOT use it for a single lookup when you already know the file: just Read it.',
    inputSchema: schema,

    // A read-only sub-agent is safe to run alongside others; a general one is not.
    // 只读子代理可与其他调用并行；general 型不可。
    isReadOnly: input => (input.subagent_type ?? 'explore') === 'explore',
    isConcurrencySafe: input => (input.subagent_type ?? 'explore') === 'explore',

    renderCall: input => `Agent(${input.description})`,
    renderResult: result => {
      const data = result.data as { turns: number } | undefined
      return data ? `sub-agent finished in ${data.turns} turn(s)` : 'done'
    },

    // 本函数：派生并跑完一个子代理，只把它的最终发言带回父级。
    // 整体流程：1 定型别与 agentId → 2 派生子上下文（独立中断与读取状态，共享权限与文件历史）
    //          → 3 explore 型额外钉进 plan 模式，强制只读 → 4 剔掉子代理不得拥有的工具
    //          → 5 跑嵌套循环（自带 20 圈上限）→ 6 只回传最终文本，其余全部丢弃。
    async execute(input, ctx) {
      // 步骤 1：定型别与 id。
      const type = input.subagent_type ?? 'explore'
      const agentId = `agent_${randomUUID().slice(0, 8)}`

      // 步骤 2：派生子上下文。
      const childCtx = createSubagentContext(ctx, agentId)
      // A read-only sub-agent is confined by plan mode, whatever the parent is in.
      // 只读子代理一律被 plan 模式约束，无论父级处于什么模式。
      // 步骤 3：explore 型钉进 plan 模式。
      if (type === 'explore') {
        childCtx.permissions = { ...childCtx.permissions, mode: 'plan' }  // 只改子上下文的模式副本，父级模式不受影响；explore 型子代理因此被钉死在只读
      }

      // 步骤 4：裁剪工具池。
      const tools = deps.getTools().filter(tool => !DISALLOWED_FOR_SUBAGENTS.has(tool.name))  // 剔除 Agent 自身以断掉无限递归，同时剔除 ExitPlanMode（子代理没有可批准计划的用户）

      // 步骤 5：跑嵌套循环。它就是同一个 query()，只是换了上下文与工具清单。
      const { text, turns } = await deps.runNestedQuery({
        messages: [{ role: 'user', content: input.prompt }],
        tools,
        systemPrompt: AGENT_PROMPTS[type],
        ctx: childCtx,
        maxTurns: 20,  // 子代理独立限圈，父级回合数与它无关；跑飞的子代理最多烧掉这 20 圈就被强制收尾
      })

      // Only the final message crosses back. Everything else is discarded —
      // that discarding IS the feature.
      // 只有最终消息回传，其余全部丢弃——「丢弃」本身就是这个特性的价值所在。
      // 步骤 6：只回传最终文本。
      return {
        result: text.trim() || '(the sub-agent produced no output)',
        data: { turns, agentId },
      }
    },
  })
}
