// 本文件：Write 工具——整体写入或新建文件，覆盖已存在文件前要求先读过。
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { buildTool } from '../Tool.js'
import { toAbsolute, toDisplayPath } from '../utils/paths.js'

const schema = z.strictObject({
  file_path: z.string().describe('Absolute or project-relative path to write.'),
  content: z.string().describe('The COMPLETE contents of the file. Not a fragment.'),
})

/**
 * Write a whole file.
 * 整体写入一个文件。
 *
 * The read-before-overwrite rule matters here as much as in Edit: overwriting
 * a file the model has never seen is how you lose work. Creating a NEW file is
 * fine without a prior read, because there is nothing to lose.
 * 「先读后覆盖」在这里和 Edit 一样重要：覆盖模型从未看过的文件正是丢失成果的方式。
 * 新建文件则无需先读，因为没有东西可丢。
 */
export const FileWriteTool = buildTool({
  name: 'Write',
  description:
    'Write a file to the local filesystem, overwriting it if it exists. ' +
    'Use this for creating new files or fully replacing one you have already Read. ' +
    'For partial changes use Edit instead — it is cheaper and safer.',
  inputSchema: schema,

  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  renderCall: input => `Write(${input.file_path})`,
  renderResult: result => {
    const data = result.data as { lines: number; created: boolean } | undefined
    if (!data) return 'written'
    return `${data.created ? 'created' : 'updated'}, ${data.lines} lines`
  },

  // 本函数：文件已存在且本会话未读过时拒绝覆盖，避免丢失看不见的内容。
  validateInput(input, ctx) {
    const path = toAbsolute(ctx.cwd, input.file_path)
    if (existsSync(path) && !ctx.readFileState.has(path)) {
      return {
        ok: false,
        message:
          `${input.file_path} already exists and has not been read in this session. ` +
          'Use Read first so you do not discard content you cannot see.',
      }
    }
    return { ok: true }
  },

  // 本函数：补建所需目录并整体写入文件，随后刷新读取状态缓存。
  async execute(input, ctx) {
    const path = toAbsolute(ctx.cwd, input.file_path)
    const created = !existsSync(path)

    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, input.content, 'utf8')

    // Keep the cache honest: we now know exactly what is on disk.
    // 让缓存与事实一致：此刻磁盘上的内容我们完全清楚。
    ctx.readFileState.set(path, { timestamp: Date.now(), mtimeMs: statSync(path).mtimeMs })

    const lines = input.content.split(/\r?\n/).length
    return {
      result: `${created ? 'Created' : 'Updated'} ${toDisplayPath(ctx.cwd, path)} (${lines} lines).`,
      data: { lines, created },
    }
  },
})
