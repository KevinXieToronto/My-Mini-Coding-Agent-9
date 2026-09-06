import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { Tool } from '../Tool.js'

/**
 * A throwaway tool, here only so Chapter 3's loop has something to call.
 * Chapter 4 rebuilds it properly against the full Tool contract.
 */
export const ListDirTool: Tool = {
  name: 'ListDir',
  description:
    'List the files and directories directly inside a path. Use this to orient ' +
    'yourself in an unfamiliar project before reading files.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory to list. Relative paths resolve against the working directory.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },

  async execute(input, ctx) {
    const { path } = input as { path?: string }
    if (typeof path !== 'string') throw new Error('`path` must be a string')

    const target = isAbsolute(path) ? path : resolve(ctx.cwd, path)
    const entries = readdirSync(target)
      .slice(0, 200)
      .map(name => {
        const isDir = statSync(join(target, name)).isDirectory()
        return isDir ? `${name}/` : name
      })
      .sort()

    if (entries.length === 0) return `${target} is empty`
    return `${target}\n${entries.join('\n')}`
  },
}
