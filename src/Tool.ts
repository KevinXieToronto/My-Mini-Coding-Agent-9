import type OpenAI from 'openai'

/**
 * The capability contract. Every capability mini-cc has — reading files,
 * running commands, spawning sub-agents, calling an MCP server — implements
 * this one interface. Nothing gets a side channel.
 * 能力契约：读文件、执行命令、派生子代理、调用 MCP 服务器等所有能力都实现这一个接口，
 * 谁也不能走旁路。
 *
 * That single rule is what makes one permission gate sufficient (Ch.6, Ch.9).
 * 正因这条规则，一道权限闸门就够用（第 6、9 章）。
 *
 * cf. src/Tool.ts in the Claude Code tree: same idea, about 40 members.
 * We start with five and grow it as chapters need more.
 * 参见 Claude Code 的 src/Tool.ts：同样思路，约 40 个成员。此处先给 5 个，按章节需要扩充。
 */
export type Tool = {
  name: string
  /**
   * Shown to the model. This is prompt engineering, not documentation.
   * 展示给模型看。这是提示工程，不是文档。
   */
  description: string
  /**
   * JSON Schema for the arguments. Ch.4 generates this from zod.
   * 参数的 JSON Schema。第 4 章改由 zod 生成。
   */
  parameters: Record<string, unknown>
  /**
   * Execute the call. Input is already-parsed JSON from the model.
   * 执行调用。入参是已解析好的模型 JSON。
   */
  execute(input: unknown, ctx: ToolContext): Promise<string>
}

/**
 * The ambient environment handed to every tool: everything a tool needs but
 * should not construct for itself.
 * 交给每个工具的环境上下文：工具所需、但不该自行构造的东西。
 *
 * Passing it explicitly instead of reaching for globals is what makes
 * sub-agents possible in Ch.14 — a sub-agent is the same loop with a different
 * context object.
 * 显式传递而非依赖全局变量，才使第 14 章的子代理成为可能——
 * 子代理就是换了个 context 对象的同一个循环。
 *
 * cf. ToolUseContext in src/Tool.ts.
 * 参见 src/Tool.ts 中的 ToolUseContext。
 */
export type ToolContext = {
  cwd: string
  abortController: AbortController
}

/**
 * Render the tool list into the shape the OpenAI API expects.
 * 将工具列表转换为 OpenAI API 期望的结构。
 */
export function toApiTools(tools: Tool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}
