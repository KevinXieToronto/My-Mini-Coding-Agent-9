import type OpenAI from 'openai'

/**
 * The capability contract. Every capability mini-cc has — reading files,
 * running commands, spawning sub-agents, calling an MCP server — implements
 * this one interface. Nothing gets a side channel.
 *
 * That single rule is what makes one permission gate sufficient (Ch.6, Ch.9).
 *
 * cf. src/Tool.ts in the Claude Code tree: same idea, about 40 members.
 * We start with five and grow it as chapters need more.
 */
export type Tool = {
  name: string
  /** Shown to the model. This is prompt engineering, not documentation. */
  description: string
  /** JSON Schema for the arguments. Ch.4 generates this from zod. */
  parameters: Record<string, unknown>
  /** Execute the call. Input is already-parsed JSON from the model. */
  execute(input: unknown, ctx: ToolContext): Promise<string>
}

/**
 * The ambient environment handed to every tool: everything a tool needs but
 * should not construct for itself.
 *
 * Passing it explicitly instead of reaching for globals is what makes
 * sub-agents possible in Ch.14 — a sub-agent is the same loop with a different
 * context object.
 *
 * cf. ToolUseContext in src/Tool.ts.
 */
export type ToolContext = {
  cwd: string
  abortController: AbortController
}

/** Render the tool list into the shape the OpenAI API expects. */
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
