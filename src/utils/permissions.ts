// 本文件：权限闸门——每次工具调用前给出 allow / ask / deny 的唯一判定入口。
import type { PermissionResult, Tool, ToolContext } from '../Tool.js'

/**
 * The permission gate, version 1.
 * 权限闸门，第一版。
 *
 * One function, called before every tool call, that answers allow / ask / deny.
 * Chapter 9 replaces the body with a rule engine and four modes; the SHAPE
 * stays exactly as it is here, which is the point of putting it behind a
 * function on day one.
 * 一个函数，在每次工具调用前被调用，答复 allow / ask / deny。
 * 第 9 章会把函数体换成规则引擎与四种模式，但「形状」保持不变——
 * 这正是第一天就把它藏在一个函数背后的意义。
 *
 * cf. hasPermissionsToUseTool in src/utils/permissions/permissions.ts, whose
 * decision ladder is literally commented 1a through 3.
 * 参见 src/utils/permissions/permissions.ts 的 hasPermissionsToUseTool，
 * 其判定阶梯的注释就是 1a 到 3。
 */
// 本函数：按「工具否决 → 只读放行 → 会话级总是允许 → 询问」的阶梯给出权限判定。
export function evaluatePermission(
  tool: Tool,
  input: unknown,
  ctx: ToolContext,
): PermissionResult {
  // 1. A tool may veto its own call, whatever anyone else thinks.
  // 1. 工具可以否决自己的调用，不管别人怎么想。
  const specific = tool.checkPermissions?.(input, ctx)
  if (specific && specific.behavior === 'deny') return specific

  // 2. Read-only calls never interrupt the human.
  //    Note this is per CALL, not per tool: Bash is read-only for `git status`
  //    and not for `git push`.
  // 2. 只读调用绝不打扰人类。
  //    注意这是按「调用」而非按「工具」判定：Bash 对 `git status` 只读、对 `git push` 不是。
  if (tool.isReadOnly?.(input)) return { behavior: 'allow' }

  // 3. The user already said "always allow" for this tool this session.
  // 3. 用户本会话已对该工具选过「总是允许」。
  if (ctx.sessionAllow.has(tool.name)) return { behavior: 'allow' }

  // 4. A tool that asked for a specific prompt gets it; otherwise a generic one.
  // 4. 工具若自带提示文案就用它，否则用通用文案。
  if (specific && specific.behavior === 'ask') return specific
  return { behavior: 'ask', message: describeCall(tool, input) }
}

/**
 * Human-readable one-liner for the approval prompt.
 * 用于批准提示的、人类可读的单行描述。
 */
// 本函数：生成权限询问时展示的单行调用描述，优先用工具自带的 renderCall。
export function describeCall(tool: Tool, input: unknown): string {
  if (tool.renderCall) {
    try {
      return tool.renderCall(input)
    } catch {
      // fall through to the generic form
      // 出错则退回通用形式
    }
  }
  const json = JSON.stringify(input)
  return `${tool.name}(${json.length > 120 ? `${json.slice(0, 117)}...` : json})`
}
