// 本文件：工具（能力）契约与相关类型，所有能力都实现这一个接口，并提供其构建与渲染辅助函数。
import type OpenAI from 'openai'
import type { PermissionContext } from './types/permissions.js'
import type { HooksConfig } from './types/hooks.js'
import type { FileHistory } from './utils/fileHistory.js'
import type { AppState } from './state/appState.js'
import type { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

/**
 * The capability contract.
 * 能力契约。
 *
 * Every capability mini-cc has — reading files, running commands, spawning
 * sub-agents, calling an MCP server — implements this one interface. Nothing
 * gets a side channel. That single rule is what makes one permission gate
 * sufficient (Ch.6, Ch.9).
 * 读文件、执行命令、派生子代理、调用 MCP 服务器等所有能力都实现这一个接口，谁也不能走旁路。
 * 正因这条规则，一道权限闸门就够用（第 6、9 章）。
 *
 * cf. src/Tool.ts in the Claude Code tree: the same idea with ~40 members.
 * 参见 Claude Code 的 src/Tool.ts：同样思路，约 40 个成员。
 */
export type Tool<Schema extends z.ZodType = z.ZodType> = {
  // --- identity ----------------------------------------------------------
  // --- 身份 ---
  name: string
  /**
   * Model-facing. This is prompt engineering, not documentation: it is the
   * only thing the model knows about this capability. Claude Code keeps most
   * of this text in a separate prompt.ts per tool so it can evolve
   * independently of the implementation.
   * 面向模型。这是提示工程而非文档：模型对该能力的全部认知都来自这段文字。
   * Claude Code 把它单独放在每个工具的 prompt.ts 中，以便与实现分头演进。
   */
  description: string
  /**
   * Human-facing name for the transcript. Defaults to `name`.
   * 面向人类、用于会话记录的名称。默认取 `name`。
   */
  userFacingName?: (input: z.infer<Schema>) => string

  // --- schema ------------------------------------------------------------
  // --- 模式 ---
  /**
   * zod is the source of truth; the JSON Schema the model sees is derived.
   * zod 是唯一事实来源；模型看到的 JSON Schema 由它派生。
   */
  inputSchema: Schema

  // --- semantics ---------------------------------------------------------
  // --- 语义 ---
  /**
   * Read-only calls skip the permission prompt and may run in parallel.
   * Note it takes the INPUT: `Bash` is read-only for `git status` and not for
   * `git push`. Concurrency is a property of the call, not of the tool.
   * 只读调用可跳过权限询问并可并行执行。注意入参是「本次调用」：
   * Bash 对 `git status` 只读、对 `git push` 不是。并发性属于调用，而非工具。
   */
  isReadOnly?: (input: z.infer<Schema>) => boolean
  isConcurrencySafe?: (input: z.infer<Schema>) => boolean

  // --- safety ------------------------------------------------------------
  // --- 安全 ---
  /**
   * Semantic pre-check. Runs BEFORE permissions, so a malformed call fails
   * fast without spending a human interruption.
   * 语义预检。在权限检查之前运行，让非法调用尽早失败，不必打扰人类。
   */
  validateInput?: (input: z.infer<Schema>, ctx: ToolContext) => ValidationResult
  /**
   * Tool-specific permission logic. General rules live in utils/permissions.
   * 工具专属的权限逻辑。通用规则放在 utils/permissions。
   */
  checkPermissions?: (input: z.infer<Schema>, ctx: ToolContext) => PermissionResult

  // --- execution ---------------------------------------------------------
  // --- 执行 ---
  execute: (input: z.infer<Schema>, ctx: ToolContext) => Promise<ToolResult>

  // --- rendering ---------------------------------------------------------
  // --- 渲染 ---
  /**
   * One line for the transcript, e.g. `Read(src/index.ts)`.
   * 会话记录中的一行，如 `Read(src/index.ts)`。
   */
  renderCall?: (input: z.infer<Schema>) => string
  /**
   * What the HUMAN sees of the result. The model always sees `result`.
   * 人类看到的结果呈现。模型看到的始终是 `result`。
   */
  renderResult?: (result: ToolResult, input: z.infer<Schema>) => string
}

export type ToolResult = {
  /**
   * Text handed back to the model as the tool result.
   * 作为工具结果回传给模型的文本。
   */
  result: string
  /**
   * Structured payload for renderers. Never sent to the model.
   * 供渲染器使用的结构化数据。绝不发送给模型。
   */
  data?: unknown
}

export type ValidationResult = { ok: true } | { ok: false; message: string }

/**
 * The gate's answer. Three outcomes, checked before every tool call.
 * 闸门的答复。三种结果，每次工具调用前检查。
 *
 * cf. PermissionResult in src/types/permissions.ts (which adds 'passthrough').
 * 参见 src/types/permissions.ts 中的 PermissionResult（那里还多一种 'passthrough'）。
 */
export type PermissionResult =
  | { behavior: 'allow' }
  | { behavior: 'ask'; message: string }
  | { behavior: 'deny'; message: string }

/**
 * The ambient environment handed to every tool.
 * 交给每个工具的环境上下文。
 *
 * Passing it explicitly rather than reaching for globals is what makes
 * sub-agents possible in Ch.14 — a sub-agent is the same loop with a different
 * context object.
 * 显式传递而非依赖全局变量，才使第 14 章的子代理成为可能——
 * 子代理就是换了个 context 对象的同一个循环。
 */
export type ToolContext = {
  cwd: string
  abortController: AbortController
  /**
   * Read-before-write cache: path -> when we last read it, and the mtime then.
   * FileEditTool refuses to edit a file it has not seen, or one that changed
   * underneath us. cf. readFileState on ToolUseContext.
   * 「先读后写」缓存：路径 -> 上次读取的时刻及当时的 mtime。
   * FileEditTool 拒绝编辑未曾读过、或已在背后被改动的文件。参见 ToolUseContext 的 readFileState。
   */
  readFileState: Map<string, { timestamp: number; mtimeMs: number }>
  /**
   * Tools the user chose "always allow" for, this session only. It now sits
   * alongside the persisted rules below rather than being the whole story.
   * 用户本会话选了「总是允许」的工具集合。如今它与下面的持久化规则并存，不再是全部。
   */
  sessionAllow: Set<string>
  /**
   * Modes, rules and the path jail. See src/types/permissions.ts.
   * 模式、规则与路径沙箱。参见 src/types/permissions.ts。
   */
  permissions: PermissionContext
  /**
   * Pre-edit snapshots, so Ch.10's rewind can undo file changes.
   * 改动前的文件快照，使第 10 章的回退能撤销文件修改。
   */
  fileHistory: FileHistory
  /**
   * Where we are in the message list, for checkpoint bookkeeping.
   * 当前在消息列表中的位置，用于检查点记账。
   */
  messageIndex: () => number
  /**
   * Session state that is not conversation — the todo list, for one. Shared by
   * reference, so a tool writing to it is immediately visible to the UI.
   * 非对话的会话状态（如待办清单）。按引用共享，工具写入后 UI 立即可见。
   */
  appState: AppState
  /**
   * Which agent this context belongs to. Undefined means the main loop; a
   * sub-agent (Ch.14) gets its own id and therefore its own todo list.
   * 本上下文属于哪个 agent。未定义即主循环；子代理（第 14 章）有自己的 id，也就有自己的待办清单。
   */
  agentId?: string
  /**
   * Lifecycle hooks from settings.json (Ch.16).
   * 来自 settings.json 的生命周期钩子（第 16 章）。
   */
  hooks: HooksConfig
  /**
   * Identifies this session to the hooks, which run as separate processes and
   * have no other way to tell one run from another.
   * 向钩子标识本次会话——钩子是独立进程，没有别的办法区分不同的运行。
   */
  sessionId: string
}

/**
 * Fill in fail-closed defaults. A tool that forgets to declare itself
 * read-only is treated as dangerous, never the other way round.
 * 填入「失败即关闭」的默认值。忘记声明只读的工具一律按危险处理，绝不反过来。
 *
 * cf. buildTool() in src/Tool.ts.
 * 参见 src/Tool.ts 的 buildTool()。
 */
// 本函数：为工具定义补上「失败即关闭」的默认值（非只读、非并发安全、默认放行）。
export function buildTool<Schema extends z.ZodType>(
  definition: Tool<Schema>,
): Required<Pick<Tool<Schema>, 'isReadOnly' | 'isConcurrencySafe' | 'checkPermissions'>> &
  Tool<Schema> {
  return {
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: () => ({ behavior: 'allow' as const }),
    ...definition,
  }
}

/**
 * Render the tool list into the shape the OpenAI API expects.
 * 将工具列表转换为 OpenAI API 期望的结构。
 */
// 本函数：把工具列表连同由 zod 派生的 JSON Schema 转成 OpenAI API 期望的结构。
export function toApiTools(tools: Tool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.inputSchema, {
        $refStrategy: 'none',
        target: 'openAi',
      }) as Record<string, unknown>,
    },
  }))
}

/**
 * Default transcript line when a tool does not supply `renderCall`.
 * 工具未提供 `renderCall` 时的默认会话记录行。
 */
// 本函数：工具未自定义 renderCall 时，生成其调用在会话记录中的默认单行展示。
export function defaultRenderCall(tool: Tool, input: unknown): string {
  if (tool.renderCall) return tool.renderCall(input)
  const json = JSON.stringify(input)
  return `${tool.name}(${json.length > 80 ? `${json.slice(0, 77)}...` : json})`
}
