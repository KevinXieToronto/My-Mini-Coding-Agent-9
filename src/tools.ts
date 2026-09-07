import type { Tool } from './Tool.js'
import { ListDirTool } from './tools/ListDirTool.js'

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
 */
export function getAllTools(): Tool[] {
  return [ListDirTool]
}
