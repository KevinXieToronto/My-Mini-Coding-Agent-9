// 本文件：Edit 工具——对文件做精确字符串替换，并施加「先读后写」与「防陈旧」两道护栏。
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { buildTool } from '../Tool.js'
import { toAbsolute, toDisplayPath } from '../utils/paths.js'

const schema = z.strictObject({
  file_path: z.string().describe('Absolute or project-relative path to edit.'),
  old_string: z
    .string()
    .describe(
      'The exact text to replace, including indentation. Must appear exactly once ' +
        'unless replace_all is true.',
    ),
  new_string: z.string().describe('The replacement text. Must differ from old_string.'),
  replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring one.'),
})

/**
 * Exact-string replacement.
 * 精确字符串替换。
 *
 * Why not line numbers or a diff format? Because an exact string is the only
 * edit representation that FAILS LOUDLY when the model's mental image of the
 * file is stale. A line number silently edits the wrong line; a unique string
 * that no longer matches produces an error the model can recover from.
 * 为何不用行号或 diff 格式？因为当模型对文件的印象过期时，只有精确字符串会「大声报错」。
 * 行号会悄悄改错行；而不再匹配的唯一字符串会给出模型可据以纠正的错误。
 *
 * Two guards, both in validateInput so they run before permissions:
 *   1. read-before-write — the file must be in ctx.readFileState
 *   2. staleness — its mtime must not have changed since we read it
 * 两道护栏，都放在 validateInput 中，以便先于权限检查运行：
 *   1. 先读后写——文件必须在 ctx.readFileState 中
 *   2. 陈旧性——自读取以来 mtime 不得变化
 */
export const FileEditTool = buildTool({
  name: 'Edit',
  description:
    'Perform an exact string replacement in a file. You must Read the file first. ' +
    'old_string must match the file exactly, including indentation, and must be ' +
    'unique — otherwise the edit fails. Use replace_all to change every occurrence.',
  inputSchema: schema,

  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  renderCall: input => `Edit(${input.file_path})`,
  renderResult: result => {
    const data = result.data as { replacements: number } | undefined
    return data ? `${data.replacements} replacement(s)` : 'edited'
  },

  // 本函数：编辑前校验——新旧串不同、文件已读过、mtime 未变、old_string 存在且唯一（除非 replace_all）。
  validateInput(input, ctx) {
    if (input.old_string === input.new_string) {
      return { ok: false, message: 'old_string and new_string are identical; nothing to do.' }
    }

    const path = toAbsolute(ctx.cwd, input.file_path)
    const seen = ctx.readFileState.get(path)
    if (!seen) {
      return { ok: false, message: `You must Read ${input.file_path} before editing it.` }
    }

    let stat
    try {
      stat = statSync(path)
    } catch {
      return { ok: false, message: `File not found: ${input.file_path}` }
    }
    if (stat.mtimeMs > seen.mtimeMs) {
      return {
        ok: false,
        message:
          `${input.file_path} has been modified since you read it. ` +
          'Read it again before editing, or your change will be based on stale content.',
      }
    }

    const content = readFileSync(path, 'utf8')
    const occurrences = countOccurrences(content, input.old_string)
    if (occurrences === 0) {
      return {
        ok: false,
        message:
          `old_string was not found in ${input.file_path}. ` +
          'It must match the file exactly, including whitespace and indentation.',
      }
    }
    if (occurrences > 1 && !input.replace_all) {
      return {
        ok: false,
        message:
          `old_string appears ${occurrences} times in ${input.file_path}. ` +
          'Add more surrounding context to make it unique, or pass replace_all: true.',
      }
    }
    return { ok: true }
  },

  // 本函数：以不含 await 的「读—改—写」完成替换，并回传改动附近的片段供确认。
  async execute(input, ctx) {
    const path = toAbsolute(ctx.cwd, input.file_path)

    // Read-modify-write with no awaits in between: nothing can interleave and
    // clobber the file. Claude Code marks the equivalent region with an
    // explicit "no awaits in this region" comment.
    // 读—改—写之间不含 await：没有别的任务能穿插进来把文件写坏。
    // Claude Code 在对应区域专门标注了「此处不得 await」。
    const before = readFileSync(path, 'utf8')
    const replacements = countOccurrences(before, input.old_string)
    const after = input.replace_all
      ? before.split(input.old_string).join(input.new_string)
      : before.replace(input.old_string, input.new_string)
    writeFileSync(path, after, 'utf8')

    ctx.readFileState.set(path, { timestamp: Date.now(), mtimeMs: statSync(path).mtimeMs })

    const applied = input.replace_all ? replacements : 1
    return {
      result:
        `Applied ${applied} replacement(s) to ${toDisplayPath(ctx.cwd, path)}.\n` +
        snippetAround(after, input.new_string),
      data: { replacements: applied, before, after },
    }
  },
})

// 本函数：统计子串在文本中出现的次数。
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  return haystack.split(needle).length - 1
}

/**
 * Give the model a few lines of context so it can confirm the edit landed.
 * 回传几行上下文，让模型确认编辑已生效。
 */
// 本函数：截取替换文本周围数行并加行号，让模型确认编辑已生效。
function snippetAround(content: string, marker: string): string {
  const index = content.indexOf(marker)
  if (index === -1) return ''
  const linesBefore = content.slice(0, index).split('\n')
  const allLines = content.split('\n')
  const startLine = Math.max(0, linesBefore.length - 3)
  const endLine = Math.min(allLines.length, linesBefore.length + marker.split('\n').length + 2)
  return allLines
    .slice(startLine, endLine)
    .map((line, i) => `${String(startLine + i + 1).padStart(6)}\t${line}`)
    .join('\n')
}
