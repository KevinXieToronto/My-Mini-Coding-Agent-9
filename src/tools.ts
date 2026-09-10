// 本文件：工具注册表，集中列出模型可见的全部内置工具。
import type { Tool } from './Tool.js'
import type { PermissionMode } from './types/permissions.js'
import { ListDirTool } from './tools/ListDirTool.js'
import { FileReadTool } from './tools/FileReadTool.js'
import { FileWriteTool } from './tools/FileWriteTool.js'
import { FileEditTool } from './tools/FileEditTool.js'
import { GlobTool } from './tools/GlobTool.js'
import { GrepTool } from './tools/GrepTool.js'
import { BashTool } from './tools/BashTool.js'
import { PowerShellTool } from './tools/PowerShellTool.js'
import { TodoWriteTool } from './tools/TodoWriteTool.js'
import { ExitPlanModeTool } from './tools/ExitPlanModeTool.js'
import { createAgentTool } from './tools/AgentTool.js'
import type { Settings } from './utils/config.js'

/**
 * The tool registry.
 * 工具注册表。
 *
 * cf. src/tools.ts in the Claude Code tree, where getAllBaseTools() feeds
 * getTools(permissionContext) — which drops blanket-denied and disabled tools
 * before the model ever sees them — and then assembleToolPool() merges MCP
 * tools in as a separately-sorted partition, so the built-ins stay a stable
 * prefix and the server-side prompt cache is not invalidated.
 * 参见 Claude Code 的 src/tools.ts：getAllBaseTools() 供给 getTools(permissionContext)，
 * 在模型看到之前剔除被全面拒绝和已禁用的工具；随后 assembleToolPool() 将 MCP 工具
 * 作为单独排序的分区合入，使内置工具保持稳定前缀，不致失效服务端提示缓存。
 *
 * The cast is the price of holding tools with different zod schemas in one
 * array. Each tool stays fully typed internally; only the registry is generic.
 * 这个类型断言是把不同 zod schema 的工具装进同一数组的代价。
 * 每个工具内部仍完全有类型，泛化的只是注册表。
 */
// 本函数：返回当前模式下可用的全部工具实例，供代理循环与 REPL 使用。
export function getAllTools(mode: PermissionMode = 'default'): Tool[] {
  const tools = [
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    BashTool,
    PowerShellTool,
    ListDirTool,
    TodoWriteTool,
  ] as unknown as Tool[]

  // ExitPlanMode only exists in plan mode. Advertising it otherwise invites
  // the model to call it for no reason.
  // ExitPlanMode 只在 plan 模式下存在；否则暴露它只会诱使模型无端调用。
  return mode === 'plan' ? [...tools, ExitPlanModeTool as unknown as Tool] : tools
}

/**
 * The pool a SUB-AGENT draws from.
 * 子代理的候选工具池。
 *
 * AgentTool applies the final exclusion list (no Agent, no ExitPlanMode); this
 * function exists so the registry — not the tool — decides what the pool is.
 * 最终的排除清单由 AgentTool 施加（禁 Agent、禁 ExitPlanMode）；
 * 本函数的存在是为了让「候选池」由注册表而非工具自己决定。
 */
// 本函数：返回可供子代理使用的候选工具池。
export function getSubagentTools(mode: PermissionMode = 'default'): Tool[] {
  return getAllTools(mode)
}

/**
 * The full registry, including the Agent tool.
 * 完整注册表，含 Agent 工具。
 *
 * Agent is built here rather than declared as a constant because it needs
 * query(), and query() needs the registry. Injecting the loop at construction
 * time keeps the import graph acyclic.
 * Agent 在此构造而非声明为常量，是因为它需要 query()，而 query() 又需要注册表。
 * 在构造时注入循环，可保持导入图无环。
 */
// 本函数：返回含 Agent 工具的完整注册表，并在构造时把 query 循环注入 Agent 工具。
export function getToolsWithAgent(settings: Settings, mode: PermissionMode = 'default'): Tool[] {
  const base = getAllTools(mode)
  const agent = createAgentTool({
    getTools: () => getSubagentTools(mode),
    async runNestedQuery({ messages, tools, systemPrompt, ctx, maxTurns }) {
      const { query } = await import('./query.js')
      const iterator = query({
        messages,
        settings,
        tools,
        systemPrompt,
        toolContext: ctx,
        maxTurns,
        // A sub-agent has no user to ask. Deny by default, exactly as in
        // print mode (Ch.7) and for the same reason.
        // 子代理没有可询问的用户，默认拒绝——与 print 模式（第 7 章）同理。
        canUseTool: async () => false,
      })

      let turns = 0
      while (true) {
        const step = await iterator.next()
        if (step.done) {
          turns = step.value.turns
          break
        }
      }

      // The last assistant text is the report that crosses back.
      // 最后一条助手文本即回传的报告。
      const last = [...messages].reverse().find(m => m.role === 'assistant' && m.content.trim())
      return { text: last && last.role === 'assistant' ? last.content : '', turns }
    },
  })

  return [...base, agent as unknown as Tool]
}
