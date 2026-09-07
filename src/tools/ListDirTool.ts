import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { buildTool } from '../Tool.js'

const schema = z.strictObject({
  path: z
    .string()
    .describe('Directory to list. Relative paths resolve against the working directory.'),
})

/**
 * Migrated from Chapter 3 to the full contract, as a worked example.
 * Note how much of the tool is now declaration rather than code.
 * 作为示范，从第 3 章迁移到完整契约。注意如今工具中有多少内容变成了声明而非代码。
 */
export const ListDirTool = buildTool({
  name: 'ListDir',
  description:
    'List the files and directories directly inside a path. Use this to orient ' +
    'yourself in an unfamiliar project before reading files.',
  inputSchema: schema,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  renderCall: input => `ListDir(${input.path})`,

  async execute(input, ctx) {
    const target = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path)
    const entries = readdirSync(target)
      .slice(0, 200)
      .map(name => (statSync(join(target, name)).isDirectory() ? `${name}/` : name))
      .sort()

    const header = relative(ctx.cwd, target) || '.'
    if (entries.length === 0) return { result: `${header} is empty` }
    return { result: `${header}\n${entries.join('\n')}`, data: { count: entries.length } }
  },
})
