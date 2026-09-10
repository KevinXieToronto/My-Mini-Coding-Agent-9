// 本文件：ExitPlanMode 工具，把「退出 plan 模式」做成一次要经权限闸门批准的工具调用。
import { z } from 'zod'
import { buildTool } from '../Tool.js'

const schema = z.strictObject({
  plan: z
    .string()
    .min(1)
    .describe('The plan, in markdown. Concise but complete enough to act on.'),
})

/**
 * The way out of plan mode.
 * 退出 plan 模式的出口。
 *
 * Plan mode is enforced by DENYING mutating tools (Ch.9, rung 4), not by
 * hiding them. That is the interesting choice: the model can still see that
 * Edit exists, so it plans a real edit and explains it, instead of concluding
 * it has no way to change files and giving up.
 * plan 模式靠「拒绝」改动型工具来落实（第 9 章第 4 级），而不是把它们藏起来。
 * 妙处在于：模型仍看得见 Edit，于是会规划并解释一次真实的编辑，
 * 而不会以为自己无法改文件而放弃。
 *
 * Leaving plan mode is therefore a TOOL CALL, which means it flows through the
 * same permission gate as everything else — the user is asked to approve the
 * plan, and approval is what flips the mode. There is no side channel.
 * 因此退出 plan 模式本身是一次工具调用，同样要过那道权限闸门——
 * 由用户批准计划，批准即切换模式。没有旁路。
 *
 * cf. src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts, which also carries
 * `allowedPrompts` so approval can grant semantic Bash permissions like
 * "run tests" at the same time.
 * 参见 Claude Code 的 ExitPlanModeV2Tool.ts：它还带 `allowedPrompts`，
 * 使批准的同时可授予「运行测试」这类语义化的 Bash 权限。
 */
export const ExitPlanModeTool = buildTool({
  name: 'ExitPlanMode',
  description:
    'Call this when you are in plan mode and have finished planning. Present the plan ' +
    'and ask the user to approve it. Only use this for work that requires writing code — ' +
    'if the user just asked you to research or explain something, answer them directly ' +
    'instead. Do not call this until you have actually investigated the code.',
  inputSchema: schema,

  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  renderCall: () => 'ExitPlanMode',
  renderResult: result => {
    const data = result.data as { approved: boolean } | undefined
    return data?.approved ? 'plan approved' : 'plan rejected'
  },

  validateInput(_input, ctx) {
    if (ctx.permissions.mode !== 'plan') {
      return { ok: false, message: 'Not in plan mode; there is nothing to exit.' }
    }
    return { ok: true }
  },

  /**
   * Always ask. This is the one call in plan mode that is SUPPOSED to
   * interrupt the human — approving the plan is the entire point.
   * 一律询问。这是 plan 模式下唯一「就该」打断人类的调用——批准计划正是它的全部意义。
   */
  checkPermissions(input) {
    return {
      behavior: 'ask',
      message: `Ready to code?\n\n${input.plan}`,
    }
  },

  async execute(_input, ctx) {
    // Reaching execute() means the gate said allow, which means the human
    // approved. Flip the mode.
    // 能走到 execute() 就说明闸门放行、即人类已批准。切换模式。
    ctx.permissions.mode = ctx.permissions.prePlanMode ?? 'default'  // 恢复进入 plan 前的模式，没记录过则回落到 default，而不是停在 plan
    return {
      result:
        'The user approved the plan. Plan mode is off; you may now make changes. ' +
        'Follow the plan you presented.',
      data: { approved: true },
    }
  },
})
