// 本文件：一个懂引号与转义的 shell 命令扫描器，把命令切成子命令，并提供规则模式匹配。

/**
 * Split a shell command into its subcommands, respecting quotes.
 * 在尊重引号的前提下，把 shell 命令切分成子命令。
 *
 * Chapter 6 used `command.split(/&&|\|\||;|\|/)`, which is wrong in a way that
 * matters: it splits inside quoted strings. `echo "a && b"` became two
 * subcommands, and — worse — a rule written to allow `echo "..."` could be
 * fooled by a payload containing an operator.
 * 第 6 章用的是 `command.split(/&&|\|\||;|\|/)`，它会在引号内部也切开：
 * `echo "a && b"` 被拆成两条子命令；更糟的是，允许 `echo "..."` 的规则
 * 可能被内含操作符的载荷骗过去。
 *
 * This is still not a full shell grammar (no subshells, no process
 * substitution, no here-docs). It is a scanner that knows about quoting and
 * escaping, which covers what an agent actually emits. Claude Code uses a
 * tree-sitter grammar for the real thing.
 * 这仍不是完整的 shell 文法（不处理子 shell、进程替换、here-doc），
 * 只是一个懂引号与转义的扫描器，足以覆盖代理实际产出的命令。
 * Claude Code 那边用的是 tree-sitter 文法。
 */

export type ParsedCommand = {
  /**
   * The subcommands, in order.
   * 按顺序排列的子命令。
   */
  parts: string[]
  /**
   * True if we saw something we do not model and cannot vouch for.
   * 若遇到我们无法建模、因而不敢担保的语法，则为 true。
   */
  hasUnsupportedSyntax: boolean
}

const OPERATORS = ['&&', '||', ';', '|', '\n']

// 本函数：扫描命令字符串，按引号/转义/嵌套深度安全地切出子命令，并标记不支持的语法。
export function parseCommand(command: string): ParsedCommand {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let hasUnsupportedSyntax = false
  let depth = 0

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!

    // Backslash escapes the next character (outside single quotes).
    // 反斜杠转义下一个字符（单引号内除外）。
    if (char === '\\' && quote !== "'") {
      current += char + (command[i + 1] ?? '')
      i += 1
      continue
    }

    if (quote) {
      current += char
      if (char === quote) quote = undefined
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }

    // Subshells and command substitution: we do not model these, so we flag
    // them and refuse to vouch for the command later.
    // 子 shell 与命令替换不在建模范围内：打上标记，之后不为该命令担保。
    if (char === '(' || (char === '$' && command[i + 1] === '(')) {
      hasUnsupportedSyntax = true
      depth += 1
      current += char
      continue
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1)
      current += char
      continue
    }
    if (char === '`') {
      hasUnsupportedSyntax = true
      current += char
      continue
    }

    if (depth === 0) {
      const operator = OPERATORS.find(op => command.startsWith(op, i))
      if (operator) {
        parts.push(current.trim())
        current = ''
        i += operator.length - 1
        continue
      }
    }

    current += char
  }

  if (quote) hasUnsupportedSyntax = true // unbalanced quote
  // 引号不闭合
  parts.push(current.trim())

  return { parts: parts.filter(Boolean), hasUnsupportedSyntax }
}

/**
 * Does `command` match a rule pattern?
 * `command` 是否匹配某条规则的模式？
 *
 * Patterns:
 * 模式写法：
 *   "git push"     exact, or followed by whitespace ("git push --force" matches)
 *                  精确匹配，或后接空白（`git push --force` 也算匹配）
 *   "git push:*"   the same thing, spelled the way Claude Code spells it
 *                  同上，只是照搬 Claude Code 的写法
 *   "npm run *"    a `*` matches the rest of the string
 *                  `*` 匹配其余任意内容
 */
// 本函数：判断一条命令是否匹配规则模式，支持 `:*` 后缀与 `*` 通配。
export function commandMatches(pattern: string, command: string): boolean {
  const normalised = pattern.replace(/:\*$/, '').trim()
  const target = command.trim()

  if (normalised.includes('*')) {
    const escaped = normalised
      .split('*')
      .map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    return new RegExp(`^${escaped}$`).test(target)
  }

  return target === normalised || target.startsWith(`${normalised} `)
}
