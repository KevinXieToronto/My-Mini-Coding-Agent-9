// 本文件：开发用的示例 MCP 服务器（stdio），提供 roll_dice / word_count / always_fails 三个玩具工具。
/**
 * A real MCP server, in about 50 lines. `.mcp.json` in the repo root points at
 * it, so `npm run dev` connects to it with no network and no API key.
 * 一台真实的 MCP 服务器，约 50 行。仓库根目录的 `.mcp.json` 指向它，
 * 于是 `npm run dev` 无需网络、无需 API key 即可连上。
 *
 * To try a third-party server instead, point `.mcp.json` at a published one:
 * 想换成第三方服务器，就把 `.mcp.json` 指向一个已发布的实现：
 *
 *   {
 *     "mcpServers": {
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/temp"]
 *       }
 *     }
 *   }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// 本对象：示例服务器实例，其 instructions 会成为 mini-cc 系统提示词里的一个区块。
const server = new McpServer(
  { name: 'demo', version: '1.0.0' },
  {
    instructions:
      'The demo server provides toy tools for testing. ' +
      'Use `roll_dice` for random numbers and `word_count` to count words.',
  },
)

// 本工具：投掷若干骰子并返回每次结果与总和。
server.registerTool(
  'roll_dice',
  {
    description: 'Roll one or more dice and return the results.',
    inputSchema: {
      sides: z.number().int().min(2).max(100).describe('Number of sides per die.'),
      count: z.number().int().min(1).max(10).optional().describe('How many dice. Default 1.'),
    },
  },
  async ({ sides, count = 1 }) => {
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides))
    return {
      content: [
        {
          type: 'text',
          text: `Rolled ${count}d${sides}: ${rolls.join(', ')} (total ${rolls.reduce((a, b) => a + b, 0)})`,
        },
      ],
    }
  },
)

// 本工具：统计一段文本的词数。
server.registerTool(
  'word_count',
  {
    description: 'Count the words in a piece of text.',
    inputSchema: { text: z.string().describe('The text to count.') },
  },
  async ({ text }) => ({
    content: [{ type: 'text', text: `${text.split(/\s+/).filter(Boolean).length} words` }],
  }),
)

// 本工具：永远返回错误，用于验证工具失败会作为 tool_result 回传给模型而不是抛穿循环。
server.registerTool(
  'always_fails',
  {
    description: 'A tool that always returns an error, for testing error handling.',
    inputSchema: {},
  },
  async () => ({
    content: [{ type: 'text', text: 'this tool is broken on purpose' }],
    isError: true,
  }),
)

await server.connect(new StdioServerTransport())
