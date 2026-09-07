// 本文件：项目目录树遍历工具（遵守 .gitignore、剪枝、限量），为 Glob 与 Grep 提供文件索引。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ignore, { type Ignore } from 'ignore'

/**
 * Walk a project tree once, honouring .gitignore, and hand back paths.
 * 遍历项目目录树一次（遵守 .gitignore），返回路径列表。
 *
 * Two rules make this fast enough to run on every search:
 * 两条规则让它快到可以每次搜索都跑一遍：
 *   1. prune ignored directories instead of filtering their contents
 *      1. 直接剪掉被忽略的目录，而不是过滤其中的文件
 *   2. cap the walk, so a stray node_modules cannot hang the agent
 *      2. 给遍历设上限，避免漏网的 node_modules 卡死 agent
 *
 * cf. the file-index utilities in src/utils/ in the Claude Code tree, which
 * additionally keep an mtime-sorted index so "most recently changed" is cheap.
 * cf. Claude Code 中 src/utils/ 的文件索引工具；它还维护按 mtime 排序的索引，
 * 因此"最近修改"的查询很便宜。
 */

const ALWAYS_SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.venv',
  '__pycache__',
  '.turbo',
])

export type WalkOptions = {
  cwd: string
  /**
   * Stop after this many files. Protects against pathological trees.
   * 文件数上限，防止病态目录树。
   */
  maxFiles?: number
  /**
   * Return directories as well as files.
   * 是否同时返回目录。
   */
  includeDirs?: boolean
}

export type WalkedFile = {
  /**
   * Absolute path.
   * 绝对路径。
   */
  path: string
  /**
   * Path relative to cwd, always with forward slashes so globs behave.
   * 相对 cwd 的路径，统一用正斜杠，保证 glob 匹配正常。
   */
  relative: string
  mtimeMs: number
  isDirectory: boolean
}

// 本函数：读取项目 .gitignore 构建忽略匹配器，文件缺失时返回空规则。
function loadIgnore(cwd: string): Ignore {
  const ig = ignore()
  try {
    ig.add(readFileSync(join(cwd, '.gitignore'), 'utf8'))
  } catch {
    // No .gitignore is fine.
    // 没有 .gitignore 也没关系。
  }
  return ig
}

/**
 * Normalise a Windows path to forward slashes for glob matching.
 * 把 Windows 路径统一成正斜杠，便于 glob 匹配。
 */
// 本函数：把 Windows 反斜杠路径统一成正斜杠，便于 glob 匹配。
export function toPosix(path: string): string {
  return sep === '\\' ? path.split('\\').join('/') : path
}

// 本函数：广度遍历目录树，剪掉忽略目录、限量返回文件（可选含目录）的路径与 mtime。
export function walk(options: WalkOptions): WalkedFile[] {
  const { cwd, maxFiles = 20_000, includeDirs = false } = options
  const ig = loadIgnore(cwd)
  const results: WalkedFile[] = []
  const queue: string[] = [cwd]

  while (queue.length > 0 && results.length < maxFiles) {
    const dir = queue.shift()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue // unreadable directory: skip, do not crash the search
      // 目录不可读：跳过，不要让搜索崩掉。
    }

    for (const name of entries) {
      if (ALWAYS_SKIP.has(name)) continue

      const full = join(dir, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue // broken symlink, or a file that vanished mid-walk
        // 断链的符号链接，或遍历途中消失的文件。
      }

      const rel = toPosix(relative(cwd, full))
      if (!rel) continue
      // ignore's API wants a trailing slash to recognise a directory rule.
      // ignore 的 API 需要结尾斜杠才能识别目录规则。
      if (ig.ignores(stat.isDirectory() ? `${rel}/` : rel)) continue

      if (stat.isDirectory()) {
        queue.push(full)
        if (includeDirs) {
          results.push({ path: full, relative: rel, mtimeMs: stat.mtimeMs, isDirectory: true })
        }
      } else {
        results.push({ path: full, relative: rel, mtimeMs: stat.mtimeMs, isDirectory: false })
      }
      if (results.length >= maxFiles) break
    }
  }

  return results
}
