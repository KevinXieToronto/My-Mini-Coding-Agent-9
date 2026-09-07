import picomatch from 'picomatch'
import { z } from 'zod'
import { buildTool } from '../Tool.js'
import { toAbsolute } from '../utils/paths.js'
import { walk } from '../utils/fileIndex.js'

const MAX_RESULTS = 200

const schema = z.strictObject({
  pattern: z
    .string()
    .describe('Glob pattern, e.g. "**/*.ts" or "src/**/*.{ts,tsx}". Always forward slashes.'),
  path: z
    .string()
    .optional()
    .describe('Directory to search in. Defaults to the working directory.'),
})

/**
 * Find files by name.
 * 按文件名查找文件。
 *
 * Results are sorted by modification time, newest first. That ordering is a
 * deliberate prompt-engineering choice: in a codebase you are actively working
 * on, the recently-touched files are almost always the relevant ones, and the
 * model reads the top of a list far more carefully than the bottom.
 * 结果按修改时间倒序排列。这是刻意的提示工程选择：在正在开发的代码库里，
 * 最近改动过的文件几乎总是最相关的，而模型读列表开头远比读结尾认真。
 */
export const GlobTool = buildTool({
  name: 'Glob',
  description:
    'Fast file-name search by glob pattern. Supports patterns like "**/*.ts" or ' +
    '"src/**/*.{ts,tsx}". Returns paths sorted by modification time, newest first. ' +
    'Use this when you know roughly what a file is called; use Grep when you know ' +
    'what is inside it.',
  inputSchema: schema,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  renderCall: input => `Glob(${input.pattern}${input.path ? `, ${input.path}` : ''})`,
  renderResult: result => {
    const data = result.data as { count: number } | undefined
    return data ? `${data.count} file(s)` : 'searched'
  },

  async execute(input, ctx) {
    const root = input.path ? toAbsolute(ctx.cwd, input.path) : ctx.cwd
    const isMatch = picomatch(input.pattern, { dot: true })

    const matches = walk({ cwd: root })
      .filter(file => isMatch(file.relative))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)

    if (matches.length === 0) {
      return { result: `No files match ${input.pattern}`, data: { count: 0 } }
    }

    const shown = matches.slice(0, MAX_RESULTS)
    const footer =
      matches.length > shown.length
        ? `\n... and ${matches.length - shown.length} more (narrow the pattern)`
        : ''

    return {
      result: shown.map(file => file.relative).join('\n') + footer,
      data: { count: matches.length },
    }
  },
})
