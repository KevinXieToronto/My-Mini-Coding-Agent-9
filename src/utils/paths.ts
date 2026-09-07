import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Resolve a possibly-relative path against the working directory.
 * 把可能是相对路径的输入解析为基于工作目录的绝对路径。
 */
export function toAbsolute(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

/**
 * Short, stable label for the transcript.
 * 会话记录中简短稳定的路径标签。
 */
export function toDisplayPath(cwd: string, path: string): string {
  const rel = relative(cwd, toAbsolute(cwd, path))
  return rel && !rel.startsWith('..') ? rel : path
}

/**
 * Is `path` inside `root`? Used by the path jail in Ch.9.
 * `path` 是否位于 `root` 之内？第 9 章的路径沙箱会用到。
 *
 * The `+ sep` guard is what stops C:\project-secrets from counting as inside
 * C:\project. Windows paths are compared case-insensitively.
 * 加上 `sep` 才能避免把 C:\project-secrets 误判为在 C:\project 内。
 * Windows 路径按大小写不敏感比较。
 */
export function isInside(root: string, path: string): boolean {
  const a = resolve(root).toLowerCase()
  const b = resolve(path).toLowerCase()
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep)
}
