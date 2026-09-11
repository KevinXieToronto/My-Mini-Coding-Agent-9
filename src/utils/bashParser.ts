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
// 逐字符扫描，每个字符依次过这几道判断：1 反斜杠转义（单引号内除外）→ 2 引号内原样收下
//          → 3 引号起始，记住是哪一种 → 4 子 shell / 命令替换：打不支持标记并加深度
//          → 5 深度为 0 时才把 && || ; | 当作分隔符切段
//          → 6 扫完补推最后一段，并滤掉空串。
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
    if (char === '\\' && quote !== "'") {  // 单引号内反斜杠不具转义能力，故只在单引号之外处理转义
      current += char + (command[i + 1] ?? '')
      i += 1
      continue
    }

    if (quote) {  // 引号内的字符一律原样收下，直到遇见同款引号才闭合；期间的 && ; | 都不算分隔符
      current += char
      if (char === quote) quote = undefined
      continue
    }

    if (char === '"' || char === "'") {  // 记住是哪种引号：单引号只能被单引号闭合，双引号只能被双引号闭合
      quote = char
      current += char
      continue
    }

    // Subshells and command substitution: we do not model these, so we flag
    // them and refuse to vouch for the command later.
    // 子 shell 与命令替换不在建模范围内：打上标记，之后不为该命令担保。
    if (char === '(' || (char === '$' && command[i + 1] === '(')) {  // 遇到子 shell 或 $( 命令替换：既打标记，也进入深度计数，避免其内部的操作符被当作分隔符
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

    if (depth === 0) {  // 只有在括号之外（深度为 0）才把 && || ; | 视作子命令分隔符
      const operator = OPERATORS.find(op => command.startsWith(op, i))
      if (operator) {
        parts.push(current.trim())
        current = ''
        i += operator.length - 1  // 跳过整个操作符；减 1 是因为循环末尾的 i++ 还会再前进一格
        continue
      }
    }

    current += char
  }

  if (quote) hasUnsupportedSyntax = true // unbalanced quote
  // 引号不闭合
  parts.push(current.trim())  // 循环结束时缓冲区里还剩最后一段（其后没有操作符），补推进去

  return { parts: parts.filter(Boolean), hasUnsupportedSyntax }  // 滤掉空串：尾随操作符或连写的分隔符会切出空段，留着会让 allow 的 every 判定失真
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
  const normalised = pattern.replace(/:\*$/, '').trim()  // `git push:*` 与 `git push` 语义相同，先削掉 `:*` 后缀以统一后续处理
  const target = command.trim()

  if (normalised.includes('*')) {
    const escaped = normalised
      .split('*')  // 按 `*` 切段 → 逐段转义正则元字符 → 用 `.*` 接回，使 `*` 成为模式里唯一有通配能力的字符
      .map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    return new RegExp(`^${escaped}$`).test(target)  // 锚定首尾做全串匹配，避免模式只命中命令中间的一小段
  }

  return target === normalised || target.startsWith(`${normalised} `)  // 无通配时要求全等或「模式 + 空格」开头，故 `git push` 不会误命中 `git pushall`
}
