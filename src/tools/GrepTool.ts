import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import picomatch from 'picomatch'
import { z } from 'zod'
import { buildTool } from '../Tool.js'
import { toAbsolute } from '../utils/paths.js'
import { walk } from '../utils/fileIndex.js'

const MAX_MATCHES = 200
const MAX_FILE_BYTES = 2_000_000

const schema = z.strictObject({
  pattern: z.string().describe('Regular expression to search for.'),
  path: z.string().optional().describe('File or directory to search. Defaults to the working directory.'),
  glob: z.string().optional().describe('Only search files matching this glob, e.g. "**/*.ts".'),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe('content = matching lines; files_with_matches = paths only; count = per-file counts.'),
  '-i': z.boolean().optional().describe('Case-insensitive search.'),
  '-n': z.boolean().optional().describe('Show line numbers. Default true for content mode.'),
  '-C': z.number().int().min(0).max(10).optional().describe('Lines of context around each match.'),
})

type GrepInput = z.infer<typeof schema>

/**
 * Search file CONTENTS.
 * 搜索文件内容。
 *
 * We try ripgrep first because it is an order of magnitude faster on a large
 * tree, and fall back to a pure-JS scan when it is not installed — which on
 * Windows is the common case. The fallback is not a toy: it honours
 * .gitignore, skips binaries, and caps its own output.
 * 先尝试 ripgrep：在大目录树上快一个数量级；未安装时（Windows 上很常见）
 * 退回纯 JS 扫描。这个兜底并不将就：它遵守 .gitignore、跳过二进制、自己限制输出量。
 *
 * cf. src/tools/GrepTool/ in the Claude Code tree, which ships a ripgrep
 * binary rather than hoping for one.
 * cf. Claude Code 的 src/tools/GrepTool/：它自带 ripgrep 二进制，而不是指望系统里有。
 */
export const GrepTool = buildTool({
  name: 'Grep',
  description:
    'Search file contents with a regular expression. Prefer this over reading files ' +
    'one by one. Filter with `glob` (e.g. "**/*.ts"). `output_mode` picks the shape: ' +
    '"content" for matching lines, "files_with_matches" for paths only (the default), ' +
    '"count" for per-file totals.',
  inputSchema: schema,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  renderCall: input => `Grep(${input.pattern}${input.glob ? `, ${input.glob}` : ''})`,
  renderResult: result => {
    const data = result.data as { files: number; matches: number } | undefined
    return data ? `${data.matches} match(es) in ${data.files} file(s)` : 'searched'
  },

  async execute(input, ctx) {
    const root = input.path ? toAbsolute(ctx.cwd, input.path) : ctx.cwd
    const viaRipgrep = tryRipgrep(input, root)
    return viaRipgrep ?? scanInJs(input, root)
  },
})

/**
 * Returns undefined if ripgrep is unavailable, so the caller can fall back.
 * ripgrep 不可用时返回 undefined，让调用方走兜底路径。
 */
function tryRipgrep(input: GrepInput, root: string): { result: string; data: unknown } | undefined {
  const mode = input.output_mode ?? 'files_with_matches'
  const args: string[] = ['--color=never']

  if (mode === 'files_with_matches') args.push('-l')
  else if (mode === 'count') args.push('-c')
  else {
    if (input['-n'] !== false) args.push('-n')
    if (input['-C']) args.push('-C', String(input['-C']))
  }
  if (input['-i']) args.push('-i')
  if (input.glob) args.push('--glob', input.glob)
  args.push('-e', input.pattern, root)

  try {
    const stdout = execFileSync('rg', args, {
      encoding: 'utf8',
      maxBuffer: 8_000_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return formatLines(stdout.split('\n').filter(Boolean), root, mode)
  } catch (error) {
    const code = (error as { code?: string; status?: number }).code
    // status 1 means "no matches" — a real answer, not a missing binary.
    // 退出码 1 表示"没有匹配"——这是有效答案，不是缺少二进制。
    if ((error as { status?: number }).status === 1) {
      return { result: 'No matches found.', data: { files: 0, matches: 0 } }
    }
    if (code === 'ENOENT') return undefined
    return undefined
  }
}

function scanInJs(input: GrepInput, root: string): { result: string; data: unknown } {
  const mode = input.output_mode ?? 'files_with_matches'
  let regex: RegExp
  try {
    regex = new RegExp(input.pattern, input['-i'] ? 'i' : '')
  } catch (error) {
    throw new Error(`Invalid regular expression: ${String(error)}`)
  }

  const isMatch = input.glob ? picomatch(input.glob, { dot: true }) : () => true
  const context = input['-C'] ?? 0
  const showLineNumbers = input['-n'] !== false

  const lines: string[] = []
  let fileCount = 0
  let matchCount = 0

  for (const file of walk({ cwd: root })) {
    if (!isMatch(file.relative)) continue

    let content: string
    try {
      const buffer = readFileSync(file.path)
      if (buffer.length > MAX_FILE_BYTES) continue
      // A NUL byte in the first 8 KB is the usual binary heuristic.
      // 前 8 KB 内出现 NUL 字节，是判定二进制文件的常用启发式。
      if (buffer.subarray(0, 8192).includes(0)) continue
      content = buffer.toString('utf8')
    } catch {
      continue
    }

    const fileLines = content.split(/\r?\n/)
    const hits: number[] = []
    for (let i = 0; i < fileLines.length; i++) {
      if (regex.test(fileLines[i]!)) hits.push(i)
    }
    if (hits.length === 0) continue

    fileCount += 1
    matchCount += hits.length

    if (mode === 'files_with_matches') {
      lines.push(file.relative)
    } else if (mode === 'count') {
      lines.push(`${file.relative}:${hits.length}`)
    } else {
      const emitted = new Set<number>()
      for (const hit of hits) {
        for (let i = Math.max(0, hit - context); i <= Math.min(fileLines.length - 1, hit + context); i++) {
          if (emitted.has(i)) continue
          emitted.add(i)
          const prefix = showLineNumbers ? `${file.relative}:${i + 1}:` : `${file.relative}:`
          lines.push(prefix + fileLines[i])
        }
      }
    }
    if (lines.length >= MAX_MATCHES) break
  }

  if (lines.length === 0) return { result: 'No matches found.', data: { files: 0, matches: 0 } }

  const shown = lines.slice(0, MAX_MATCHES)
  const footer = lines.length > shown.length ? `\n... truncated at ${MAX_MATCHES} lines` : ''
  return {
    result: shown.join('\n') + footer,
    data: { files: fileCount, matches: matchCount },
  }
}

function formatLines(
  lines: string[],
  root: string,
  mode: string,
): { result: string; data: unknown } {
  const shown = lines.slice(0, MAX_MATCHES)
  const cleaned = shown.map(line => line.replace(root, '').replace(/^[\\/]/, ''))
  const footer = lines.length > shown.length ? `\n... truncated at ${MAX_MATCHES} lines` : ''
  return {
    result: cleaned.join('\n') + footer,
    data: { files: mode === 'files_with_matches' ? lines.length : 0, matches: lines.length },
  }
}
