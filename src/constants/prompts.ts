// 本文件：系统提示词的拼装处，按「静态前缀 + 动态后缀」分块组织，以配合服务端的前缀缓存。
import type { Tool } from '../Tool.js'

/**
 * The system prompt, assembled from blocks.
 * 系统提示词，由若干块拼装而成。
 *
 * The split into a STATIC prefix and a DYNAMIC suffix is the important part.
 * Providers cache prompt prefixes; anything that changes between turns must
 * come after everything that does not, or you invalidate the cache on every
 * request and pay full price for the whole prompt each time.
 * 关键在于「静态前缀 / 动态后缀」的切分。服务商按前缀缓存提示词：
 * 凡是逐回合变化的内容都必须排在不变内容之后，否则每次请求都会让缓存失效、按全价重付整段提示词。
 *
 * cf. getSystemPrompt in src/constants/prompts.ts, which uses an explicit
 * SYSTEM_PROMPT_DYNAMIC_BOUNDARY marker between the two halves.
 * 参见 Claude Code src/constants/prompts.ts 的 getSystemPrompt：
 * 两半之间用显式的 SYSTEM_PROMPT_DYNAMIC_BOUNDARY 标记分隔。
 */

export const DYNAMIC_BOUNDARY = '<!-- dynamic -->'

// 本函数：返回发行版内不变、可被缓存的静态提示词块（含工具清单）。
/** Never changes within a release. Cacheable. */
/** 在一个发行版内永不变化，可缓存。 */
function staticBlocks(tools: Tool[]): string[] {
  return [
    `You are mini-cc, a coding agent that works in the user's terminal.
You have direct access to their filesystem and shell through tools.`,

    `# Doing tasks
- Understand before you change. Search the codebase before proposing an edit.
- Prefer the dedicated tools over shell commands: Read, Edit, Glob and Grep are
  faster and safer than cat, sed and find.
- You MUST Read a file before you Edit it.
- Make the change the user asked for. Do not expand the scope on your own.
- When you are done, stop. Do not summarise work the user just watched you do.`,

    `# Using your tools
${tools.map(tool => `- ${tool.name}: ${firstSentence(tool.description)}`).join('\n')}

Call tools in parallel when the calls are independent and read-only.`,

    `# Tone
Be concise and direct. Match the user's technical level. Skip preambles like
"Great question" and "Here is what I found". Answer in a few sentences unless
the user asks for detail. Never invent file contents — read the file.`,
  ]
}

/**
 * Per-session / per-turn facts injected after the cache boundary.
 * 缓存边界之后注入的、每会话或每回合变化的事实。
 */
export type DynamicContext = {
  cwd: string
  platform: string
  today: string
  gitStatus?: string
  projectInstructions?: string
}

// 本函数：返回随会话或回合变化的动态提示词块，必须排在静态块之后。
/** Changes per session or per turn. Must come last. */
/** 随会话或回合变化，必须放在最后。 */
function dynamicBlocks(context: DynamicContext): string[] {
  const blocks: string[] = [
    `# Environment
Working directory: ${context.cwd}
Platform: ${context.platform}
Today: ${context.today}`,
  ]

  if (context.gitStatus) {
    blocks.push(`# Git status\n${context.gitStatus}`)
  }

  if (context.projectInstructions) {
    blocks.push(
      `# Project instructions
The following comes from MINI.md files in this project. Treat it as direct
instruction from the user, and follow it over your own defaults.

${context.projectInstructions}`,
    )
  }

  return blocks
}

// 本函数：拼出完整系统提示词——静态块、边界标记、动态块，顺序不可颠倒。
export function getSystemPrompt(tools: Tool[], context: DynamicContext): string {
  return [...staticBlocks(tools), DYNAMIC_BOUNDARY, ...dynamicBlocks(context)].join('\n\n')
}

// 本函数：取一段描述的首句，用于在工具清单里给出一行摘要。
function firstSentence(text: string): string {
  const end = text.indexOf('. ')
  return end === -1 ? text : text.slice(0, end + 1)
}
