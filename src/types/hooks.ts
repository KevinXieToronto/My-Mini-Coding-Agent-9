// 本文件：生命周期钩子的类型定义——事件名、配置结构、钩子的输入负载与输出协议。
/**
 * Lifecycle hooks: user-configured commands that run at fixed points and can
 * change what happens next.
 * 生命周期钩子：用户配置的命令，在固定时点运行，并能改变接下来发生的事。
 *
 * This is the mirror image of MCP (Ch.17). ARCHITECTURE.md puts it well:
 * 它是 MCP（第 17 章）的镜像。ARCHITECTURE.md 说得很好：
 *
 *   "Extensions add capability; hooks subtract it. MCP servers inject tools
 *    into the registry. Hooks intercept calls the model already made. They sit
 *    at opposite ends of the same pipeline."
 *   「扩展做加法，钩子做减法。MCP 服务器往注册表里注入工具；钩子拦截模型已经发出的调用。
 *    两者位于同一条流水线的两端。」
 *
 * cf. src/types/hooks.ts and src/schemas/hooks.ts. Claude Code has 27 events;
 * we implement the five that carry the design.
 * 参见 src/types/hooks.ts 与 src/schemas/hooks.ts。Claude Code 有 27 个事件，
 * 我们只实现承载设计的那五个。
 */

export type HookEvent =
  /** Before a tool runs. May block it or rewrite its input. */
  /** 工具执行前。可阻止该调用，或改写其入参。 */
  | 'PreToolUse'
  /** After a tool ran. May inject context for the model. */
  /** 工具执行后。可为模型注入上下文。 */
  | 'PostToolUse'
  /** Before a user prompt reaches the model. May add context or block it. */
  /** 用户提问抵达模型前。可追加上下文，或直接拦下。 */
  | 'UserPromptSubmit'
  /** Once, at startup. May inject context. */
  /** 启动时一次。可注入上下文。 */
  | 'SessionStart'
  /** When a turn ends. May force the agent to keep going. */
  /** 回合结束时。可迫使代理继续干活。 */
  | 'Stop'

export const HOOK_EVENTS: HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
]

export type HookCommand = {
  /** Only 'command' is implemented; the field exists so config stays
   *  forward-compatible with the prompt/agent/http kinds Claude Code has. */
  /** 目前只实现 'command'；保留该字段是为了与 Claude Code 的 prompt/agent/http
   *  等类型保持配置层面的前向兼容。 */
  type?: 'command'
  /** Shell command to run. Receives the event payload as JSON on stdin. */
  /** 要执行的 shell 命令。事件负载以 JSON 从 stdin 传入。 */
  command: string
  /** Milliseconds. Default 30000. */
  /** 毫秒。默认 30000。 */
  timeout?: number
}

export type HookMatcher = {
  /**
   * Which tools this applies to. A regex against the tool name, or a
   * permission-rule string like "Bash(git push *)". Absent means "all".
   * Only meaningful for the tool events.
   * 作用于哪些工具。可以是匹配工具名的正则，也可以是形如 "Bash(git push *)" 的权限规则串。
   * 缺省即「全部」。仅对工具类事件有意义。
   */
  matcher?: string
  hooks: HookCommand[]
}

export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>

/** What a hook receives on stdin. */
/** 钩子从 stdin 收到的内容。 */
export type HookInput = {
  hook_event_name: HookEvent
  session_id: string
  cwd: string
  tool_name?: string
  tool_input?: unknown
  tool_response?: string
  prompt?: string
}

/**
 * What a hook may print on stdout, as JSON.
 * 钩子可以在 stdout 上打印的内容，格式为 JSON。
 *
 * A hook that prints nothing (or non-JSON) is treated as "no opinion", so the
 * simplest useful hook is a one-line formatter that ignores this entirely.
 * 什么都不打印（或打印的不是 JSON）视为「无意见」，
 * 所以最简单也最有用的钩子就是一行式格式化命令，压根不理会这套协议。
 */
export type HookOutput = {
  /** false stops the turn. */
  /** false 表示终止本回合。 */
  continue?: boolean
  /** Shown to the user when continue is false. */
  /** continue 为 false 时展示给用户的说明。 */
  stopReason?: string
  /** Text appended to the conversation for the model to read. */
  /** 追加进对话、供模型阅读的文本。 */
  additionalContext?: string
  /** PreToolUse only. */
  /** 仅 PreToolUse 有效。 */
  permissionDecision?: 'allow' | 'deny' | 'ask'
  permissionDecisionReason?: string
  /** PreToolUse only: replace the tool's arguments. */
  /** 仅 PreToolUse 有效：替换该工具的入参。 */
  updatedInput?: Record<string, unknown>
}
