// 本文件：读取并校验 `.mcp.json` 里的 MCP 服务器配置，并提供工具名命名空间化辅助函数。

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { CONFIG_DIR_NAME } from '../../constants/product.js'

/**
 * MCP server configuration, from `.mcp.json`.
 * MCP 服务器配置，来自 `.mcp.json`。
 *
 * The shape is the ecosystem convention, so a server someone documented for
 * another MCP client works here unchanged:
 * 沿用生态通用格式，为其他 MCP 客户端写的服务器配置可直接复用：
 *
 *   {
 *     "mcpServers": {
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/temp"]
 *       },
 *       "docs": { "type": "http", "url": "https://example.com/mcp" }
 *     }
 *   }
 *
 * cf. src/services/mcp/config.ts.
 * 参见 src/services/mcp/config.ts。
 */

const StdioServerSchema = z.object({
  type: z.literal('stdio').optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
})

const HttpServerSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
})

export const McpServerSchema = z.union([StdioServerSchema, HttpServerSchema])
export type McpServerConfig = z.infer<typeof McpServerSchema>

const McpConfigSchema = z.object({
  mcpServers: z.record(McpServerSchema).default({}),
})

// 本函数：按“用户级 → 项目级”顺序合并 MCP 服务器配置，坏配置只警告不致命。
export function loadMcpConfig(cwd: string): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {}

  for (const path of [join(homedir(), CONFIG_DIR_NAME, 'mcp.json'), join(cwd, '.mcp.json')]) {
    if (!existsSync(path)) continue
    try {
      const parsed = McpConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
      if (!parsed.success) {
        console.error(`[mini-cc] ignoring malformed MCP config at ${path}`)
        continue
      }
      Object.assign(servers, parsed.data.mcpServers)
    } catch (error) {
      console.error(`[mini-cc] ignoring MCP config at ${path}: ${String(error)}`)
    }
  }

  return servers
}

/**
 * MCP tool names are namespaced so a server cannot shadow a built-in.
 * MCP 工具名加命名空间，防止服务器覆盖内置工具。
 *
 * A server called "filesystem" exposing "read_file" becomes
 * `mcp__filesystem__read_file`. Without this, a hostile or careless server
 * could register a tool called "Bash" and the model would call it thinking it
 * was yours.
 * 例如 filesystem 的 read_file 变为 `mcp__filesystem__read_file`；否则恶意或粗心的
 * 服务器可注册名为 "Bash" 的工具，模型会误当作内置工具调用。
 */
// 本函数：把服务器名与工具名拼成带命名空间的工具名。
export function namespacedName(serverName: string, toolName: string): string {
  return `mcp__${sanitize(serverName)}__${sanitize(toolName)}`
}

// 本函数：清洗名称中的非法字符，只保留字母、数字、下划线与连字符。
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}
