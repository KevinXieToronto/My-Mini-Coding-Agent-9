// 本文件：钩子引擎——匹配器判定、子进程执行与输出解析，以及按事件聚合多个钩子意见的运行器。
import { spawn } from 'node:child_process'
import type { HookCommand, HookEvent, HookInput, HookOutput, HooksConfig } from '../types/hooks.js'
import { commandMatches } from './bashParser.js'

/**
 * Hooks are the subtractive half of extensibility: MCP (Ch.17) injects tools,
 * hooks intercept the calls the model already made.
 * 钩子是可扩展性中「做减法」的那一半：MCP（第 17 章）注入工具，钩子拦截模型已发出的调用。
 *
 * cf. src/services/hooks/ in the Claude Code tree.
 * 参见 Claude Code 的 src/services/hooks/。
 */

const DEFAULT_TIMEOUT_MS = 30_000

export type HookRunResult = {
  output: HookOutput
  stdout: string
  stderr: string
  exitCode: number | null
}

/**
 * Does a matcher apply?
 * 某个匹配器是否适用？
 *
 * Two syntaxes, because two things are natural to express:
 * 两种写法，因为要表达的正好是两件事：
 *   "Edit|Write"        a regex over the tool NAME
 *                       对「工具名」的正则
 *   "Bash(git push *)"  a permission-style rule over the tool's subject
 *                       对「调用对象」的权限式规则
 *
 * Reusing Ch.9's commandMatches means "Bash(git push *)" behaves identically
 * here and in a permission rule. Claude Code makes the same connection: its
 * hook conditions go through Tool.preparePermissionMatcher, the very same
 * machinery the permission rules use.
 * 复用第 9 章的 commandMatches，意味着 "Bash(git push *)" 在钩子匹配器和权限规则中的行为完全一致。
 * Claude Code 建立了同样的联系——它的钩子条件走的是 Tool.preparePermissionMatcher，
 * 和权限规则同一套机制。
 */
// 本函数：判断一条钩子匹配器是否适用于本次工具调用，支持工具名正则与权限规则两种写法。
export function matcherApplies(
  matcher: string | undefined,
  toolName: string,
  input: unknown,
): boolean {
  if (!matcher) return true

  const ruleMatch = /^([A-Za-z_][\w-]*)\((.*)\)$/.exec(matcher.trim())  // 带括号即按权限规则解析（工具名 + 主体模式），不带括号才落到下面的工具名正则分支
  if (ruleMatch) {
    if (ruleMatch[1] !== toolName) return false
    const record = (input ?? {}) as Record<string, unknown>
    const subject =  // 与权限引擎取同一个「主体」：shell 类看 command，文件类看 file_path，都没有就拿空串去匹配（几乎必然不命中）
      typeof record.command === 'string'
        ? record.command
        : typeof record.file_path === 'string'
          ? record.file_path
          : ''
    return commandMatches(ruleMatch[2]!, subject)
  }

  try {
    return new RegExp(`^(${matcher})$`).test(toolName)  // 首尾加锚点并整体分组，使 "Edit|Write" 匹配整个工具名，而不是只匹配其中一段
  } catch {
    // A matcher that is not a valid regex is treated as a literal name, never
    // as "matches everything" — fail closed.
    // 非法正则按字面工具名处理，绝不当作「匹配一切」——失败即关闭。
    return matcher === toolName
  }
}

/** Run one hook and parse whatever it printed. */
/** 执行单个钩子，并解析它打印出来的内容。 */
// 本函数：以子进程方式运行一个钩子命令，把事件负载写入 stdin，带超时地收集其输出。
export function runHook(hook: HookCommand, payload: HookInput, cwd: string): Promise<HookRunResult> {
  return new Promise(resolve => {
    const child = spawn(hook.command, {
      cwd,
      shell: true, // hooks are written as shell one-liners
      // 钩子就是写成一行的 shell 命令
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    // 本函数：只结算一次——清掉超时器并把收集到的输出交回。
    const finish = (exitCode: number | null): void => {
      if (settled) return  // 超时、启动失败、正常退出可能先后触发，这个闩确保 Promise 只结算一次
      settled = true
      clearTimeout(timer)
      resolve({ output: parseHookOutput(stdout), stdout, stderr, exitCode })
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      stderr += `\n[hook timed out after ${hook.timeout ?? DEFAULT_TIMEOUT_MS}ms]`
      finish(null)
    }, hook.timeout ?? DEFAULT_TIMEOUT_MS)

    child.stdout.on('data', chunk => (stdout += String(chunk)))
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    child.on('error', error => {
      // A hook that will not even start must not take the agent down with it.
      // 连启动都失败的钩子，不该把整个代理一起拖垮。
      stderr += `\n[hook failed to start: ${error.message}]`
      finish(null)
    })
    child.on('close', code => finish(code))

    child.stdin.end(JSON.stringify(payload))  // 写完负载立刻关闭 stdin：钩子读到 EOF 才会结束，不关就会一直等下去
  })
}

/**
 * A hook that prints nothing, or prints something that is not JSON, has no
 * opinion. That is the common case — a formatter hook just runs and exits —
 * so it must not be an error.
 * 什么都不打印、或打印的不是 JSON 的钩子，视为「无意见」。
 * 这才是常态——格式化钩子跑完就退出——所以绝不能当成错误。
 */
// 本函数：把钩子的 stdout 解析成 HookOutput，非 JSON 一律视为「无意见」返回空对象。
export function parseHookOutput(stdout: string): HookOutput {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) return {}  // 先看首字符再解析：格式化钩子往往打印一堆日志，直接 JSON.parse 只会白抛一次异常
  try {
    return JSON.parse(trimmed) as HookOutput
  } catch {
    return {}  // 解析失败也当「无意见」，绝不因此拦下调用——写坏的钩子不该改变授权结果
  }
}

/**
 * The hook commands registered for one event, filtered by matcher.
 * 某个事件下注册的钩子命令，按匹配器过滤后的结果。
 *
 * Matchers only mean something for the tool events; for the rest every
 * registered hook applies.
 * 匹配器只对工具类事件有意义；其余事件下所有注册的钩子都适用。
 */
// 本函数：挑出某事件下、与本次调用匹配的全部钩子命令。
function selectHooks(config: HooksConfig, event: HookEvent, payload: HookInput): HookCommand[] {
  const selected: HookCommand[] = []
  for (const entry of config[event] ?? []) {
    const applies =  // 负载里没有 tool_name 就说明这不是工具类事件（Stop、SessionStart 等），匹配器无从谈起，一律视为适用
      payload.tool_name === undefined ||
      matcherApplies(entry.matcher, payload.tool_name, payload.tool_input)
    if (applies) selected.push(...entry.hooks)
  }
  return selected
}

export type PreToolUseResult = {
  decision?: 'allow' | 'deny' | 'ask'
  reason?: string
  updatedInput?: Record<string, unknown>
}

/**
 * PreToolUse: the only hook event that can say no.
 * PreToolUse：唯一能说「不」的钩子事件。
 *
 * Hooks run in order and DENY WINS, immediately — the remaining hooks are not
 * even started. That asymmetry is the whole point: hooks subtract capability,
 * so the restrictive answer must be the one that survives.
 * 钩子按序执行，「拒绝」即刻胜出——后面的钩子根本不会启动。
 * 这种不对称正是要害：钩子做减法，更严格的那个答案必须活到最后。
 *
 * An `updatedInput` is fed forward, so a later hook sees what an earlier one
 * rewrote rather than the model's original arguments.
 * `updatedInput` 会向后传递：后续钩子看到的是前一个钩子改写后的入参，而非模型的原始参数。
 */
// 本函数：按序运行 PreToolUse 钩子，聚合出放行/拒绝/询问的决定与可能被改写的入参。
export async function runPreToolUseHooks(
  config: HooksConfig,
  payload: HookInput,
  cwd: string,
): Promise<PreToolUseResult> {
  const commands = selectHooks(config, 'PreToolUse', payload)
  if (commands.length === 0) return {}

  const result: PreToolUseResult = {}
  let current = payload

  for (const command of commands) {
    const { output } = await runHook(command, current, cwd)

    if (output.updatedInput) {
      result.updatedInput = output.updatedInput
      current = { ...current, tool_input: output.updatedInput }  // 改写后的入参喂给下一个钩子，于是后面的钩子看到的是最新版本而非模型原始参数
    }

    if (output.permissionDecision === 'deny' || output.continue === false) {  // 拒绝即刻返回，后续钩子不再启动——更严格的答案必须胜出
      return {
        ...result,
        decision: 'deny',
        reason: output.permissionDecisionReason ?? output.stopReason,
      }
    }
    if (output.permissionDecision === 'ask') {
      result.decision = 'ask'
      result.reason = output.permissionDecisionReason
    } else if (output.permissionDecision === 'allow' && result.decision !== 'ask') {  // 多加的 !== 'ask' 判断保证放行只能升级 undefined，不能把已有的「询问」降级
      // An explicit allow skips the gate, but never overrides a prior 'ask'.
      // 显式放行会跳过闸门，但绝不覆盖此前已经产生的 'ask'。
      result.decision = 'allow'
      result.reason = output.permissionDecisionReason
    }
  }

  return result
}

export type ContextHookResult = {
  additionalContext?: string
  blocked?: boolean
  reason?: string
}

/**
 * The events whose only power is to ADD text: PostToolUse, UserPromptSubmit
 * and SessionStart. UserPromptSubmit may also refuse the prompt outright.
 * 这些事件唯一的权力是「追加文本」：PostToolUse、UserPromptSubmit 与 SessionStart。
 * 其中 UserPromptSubmit 还可以直接拒掉这次提问。
 */
// 本函数：运行某个「注入上下文」类事件下的全部钩子，拼接其 additionalContext 并汇报是否被拦下。
export async function runContextHooks(
  config: HooksConfig,
  event: HookEvent,
  payload: HookInput,
  cwd: string,
): Promise<ContextHookResult> {
  const commands = selectHooks(config, event, payload)
  if (commands.length === 0) return {}

  const parts: string[] = []
  for (const command of commands) {
    const { output } = await runHook(command, payload, cwd)
    if (output.additionalContext) parts.push(output.additionalContext)
    if (output.continue === false) {
      return {
        additionalContext: parts.length ? parts.join('\n') : undefined,  // 即便被拦下也把此前钩子已注入的文本带回：那是解释「为何被拦」的线索，不该一并丢掉
        blocked: true,
        reason: output.stopReason,
      }
    }
  }

  return { additionalContext: parts.length ? parts.join('\n') : undefined }
}

export type StopHookResult = { keepGoing: boolean; reason?: string }

/**
 * Stop: the hook that can refuse to let the turn end.
 * Stop：能拒绝让回合结束的那个钩子。
 *
 * `continue: true` here means "no, keep going" — the turn was already about to
 * stop, so the only interesting answer is the one that pushes it around again.
 * 此处 `continue: true` 意为「别停，继续」——回合本就要结束了，
 * 唯一有意思的回答，正是把它再推一圈的那个。
 */
// 本函数：运行 Stop 钩子，判断是否有钩子要求代理继续干活，并带回它给出的理由。
export async function runStopHooks(
  config: HooksConfig,
  payload: HookInput,
  cwd: string,
): Promise<StopHookResult> {
  const commands = selectHooks(config, 'Stop', payload)
  if (commands.length === 0) return { keepGoing: false }

  for (const command of commands) {
    const { output } = await runHook(command, payload, cwd)
    if (output.continue === true) {
      return {
        keepGoing: true,
        reason: output.stopReason ?? output.additionalContext ?? 'the work is not finished',
      }
    }
  }

  return { keepGoing: false }
}
