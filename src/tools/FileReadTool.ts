// 本文件：Read 工具——带行号读取文件，并登记读取状态供后续编辑校验使用。
import { readFileSync, statSync } from 'node:fs'
import { z } from 'zod'
import { buildTool } from '../Tool.js'
import { toAbsolute, toDisplayPath } from '../utils/paths.js'

const MAX_LINES = 2000
const MAX_LINE_LENGTH = 2000

const schema = z.strictObject({
  file_path: z.string().describe('Absolute or project-relative path to the file to read.'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based line number to start from. Use for files too large to read at once.'),
  limit: z.number().int().min(1).optional().describe('How many lines to read.'),
})

/**
 * Read a file, numbered like `cat -n`.
 * 读取文件，像 `cat -n` 那样带行号。
 *
 * The line numbers are not decoration: they are how the model refers to
 * regions of the file in conversation, and how you spot that it is quoting a
 * stale version.
 * 行号不是装饰：模型靠它在对话中指代文件区域，你也靠它发现模型引用的是旧版本。
 *
 * Side effect: records the read in ctx.readFileState. FileEditTool refuses to
 * edit a file that is not in that cache — see the read-before-write rule.
 * 副作用：把本次读取记入 ctx.readFileState。FileEditTool 拒绝编辑不在该缓存中的文件——
 * 即「先读后写」规则。
 */
export const FileReadTool = buildTool({
  name: 'Read',
  description:
    'Read a file from the local filesystem. Returns the contents with line numbers, ' +
    'like `cat -n`. You MUST use this before editing a file. For large files, page ' +
    'through with `offset` and `limit`.',
  inputSchema: schema,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  renderCall: input => `Read(${input.file_path})`,
  renderResult: result => {
    const data = result.data as { lines: number } | undefined
    return data ? `${data.lines} lines` : 'read'
  },

  // 本函数：读取前校验目标存在且不是目录。
  validateInput(input, ctx) {
    const path = toAbsolute(ctx.cwd, input.file_path)
    let stat
    try {
      stat = statSync(path)
    } catch {
      return { ok: false, message: `File not found: ${input.file_path}` }
    }
    if (stat.isDirectory()) {
      return { ok: false, message: `${input.file_path} is a directory. Use ListDir instead.` }
    }
    return { ok: true }
  },

  // 本函数：按 offset/limit 分页读取文件、加行号返回，并记录本次读取的时刻与 mtime。
  async execute(input, ctx) {
    const path = toAbsolute(ctx.cwd, input.file_path)
    const stat = statSync(path)
    const raw = readFileSync(path, 'utf8')
    const allLines = raw.split(/\r?\n/)

    const start = (input.offset ?? 1) - 1
    const count = input.limit ?? MAX_LINES
    const slice = allLines.slice(start, start + count)

    const body = slice
      .map((line, index) => {
        const truncated =
          line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}… [truncated]` : line
        return `${String(start + index + 1).padStart(6)}\t${truncated}`
      })
      .join('\n')

    // Remember that we have seen this file, and what its mtime was.
    // 记住我们看过这个文件，以及当时的 mtime。
    ctx.readFileState.set(path, { timestamp: Date.now(), mtimeMs: stat.mtimeMs })

    const omitted = allLines.length - (start + slice.length)
    const footer = omitted > 0 ? `\n\n... ${omitted} more lines. Use offset to continue.` : ''

    if (raw.trim() === '') {
      return { result: `${toDisplayPath(ctx.cwd, path)} exists but is empty.`, data: { lines: 0 } }
    }
    return { result: body + footer, data: { lines: slice.length } }
  },
})
