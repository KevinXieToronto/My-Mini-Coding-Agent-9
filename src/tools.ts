// 本文件：工具注册表，集中列出模型可见的全部内置工具。
import type { Tool } from './Tool.js'
import { ListDirTool } from './tools/ListDirTool.js'
import { FileReadTool } from './tools/FileReadTool.js'
import { FileWriteTool } from './tools/FileWriteTool.js'
import { FileEditTool } from './tools/FileEditTool.js'
import { GlobTool } from './tools/GlobTool.js'
import { GrepTool } from './tools/GrepTool.js'
import { BashTool } from './tools/BashTool.js'
import { PowerShellTool } from './tools/PowerShellTool.js'

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
// 本函数：返回当前可用的全部工具实例，供代理循环与 REPL 使用。
export function getAllTools(): Tool[] {
  return [
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    BashTool,
    PowerShellTool,
    ListDirTool,
  ] as unknown as Tool[]
}
