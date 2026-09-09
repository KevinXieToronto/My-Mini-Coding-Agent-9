// 本文件：权限系统的纯类型定义（模式、规则、上下文、判定理由），独立于引擎以避免循环依赖。

/**
 * Permission types, kept separate from the engine so config parsing, the UI
 * and the engine can all import them without a cycle.
 * 权限类型独立成文件：配置解析、UI 与引擎都能引用而不产生循环依赖。
 *
 * cf. src/types/permissions.ts in the Claude Code tree.
 * 参见 Claude Code 的 src/types/permissions.ts。
 */

/**
 * default            ask before anything that writes
 * acceptEdits        file edits are pre-approved; commands still ask
 * plan               read-only. Nothing may mutate anything.
 * bypassPermissions  allow everything. Deny rules STILL apply.
 * default            凡写入必先询问
 * acceptEdits        文件编辑预先批准，命令仍需询问
 * plan               只读，任何东西都不得改动任何东西
 * bypassPermissions  全部放行，但 deny 规则依然生效
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export const PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]

export type RuleBehavior = 'allow' | 'deny' | 'ask'

/**
 * A parsed rule. The source text looks like:
 * 解析后的规则。原始文本形如：
 *
 *   Bash(git push:*)     tool + a content pattern
 *                        工具 + 内容模式
 *   Edit(src/**)         tool + a path pattern
 *                        工具 + 路径模式
 *   WebFetch             tool only: matches every call
 *                        仅工具名：匹配该工具的每次调用
 */
export type PermissionRule = {
  toolName: string
  /**
   * undefined means "any call to this tool".
   * undefined 表示「该工具的任意调用」。
   */
  content?: string
  behavior: RuleBehavior
  /**
   * Where the rule came from, for explaining decisions to the user.
   * 规则来源，用于向用户解释判定依据。
   */
  source: RuleSource
}

export type RuleSource = 'userSettings' | 'projectSettings' | 'cliArg' | 'session'

export type PermissionContext = {
  mode: PermissionMode
  rules: PermissionRule[]
  /**
   * Directories the agent may touch, beyond cwd.
   * 除 cwd 外，代理还可触碰的目录。
   */
  additionalDirectories: string[]
  cwd: string
  /**
   * The mode to restore when ExitPlanMode is approved.
   * plan 模式获批退出时要恢复的模式。
   */
  prePlanMode?: PermissionMode
}

/**
 * How a decision was reached — shown in the UI and useful when debugging.
 * 判定是怎么得出的——展示给 UI，也便于调试。
 */
export type DecisionReason =
  | { type: 'denyRule'; rule: PermissionRule }
  | { type: 'askRule'; rule: PermissionRule }
  | { type: 'allowRule'; rule: PermissionRule }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'readOnly' }
  | { type: 'toolPolicy' }
  | { type: 'pathJail'; path: string }
  | { type: 'default' }
