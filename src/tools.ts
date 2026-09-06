import type { Tool } from './Tool.js'
import { ListDirTool } from './tools/ListDirTool.js'

/**
 * The tool registry.
 *
 * cf. src/tools.ts in the Claude Code tree, where getAllBaseTools() feeds
 * getTools(permissionContext) — which drops blanket-denied and disabled tools
 * before the model ever sees them — and then assembleToolPool() merges MCP
 * tools in as a separately-sorted partition, so the built-ins stay a stable
 * prefix and the server-side prompt cache is not invalidated.
 */
export function getAllTools(): Tool[] {
  return [ListDirTool]
}
