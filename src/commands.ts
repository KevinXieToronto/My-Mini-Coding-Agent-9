// 本文件：斜杠命令注册表——合并内置命令与用户/项目目录下的 markdown 命令，并提供命令行解析与参数替换。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import type { Command, PromptCommand } from './types/command.js'
import { CONFIG_DIR_NAME } from './constants/product.js'
import { BUILTIN_COMMANDS } from './commands/builtins.js'

/**
 * The command registry.
 * 命令注册表。
 *
 * Built-ins first, then user-level markdown commands, then project-level ones.
 * Later definitions win, so a project can override a personal command of the
 * same name — the same general-to-specific ordering as MINI.md in Chapter 8.
 * 顺序：内置 → 用户级 markdown → 项目级；后者覆盖前者，项目可覆盖同名个人命令，
 * 与第 8 章 MINI.md 的「由通用到具体」一致。
 *
 * cf. src/commands.ts in the Claude Code tree, which additionally merges
 * plugin commands and MCP prompts (as `mcp__<server>__<prompt>`).
 * 参见 Claude Code 的 src/commands.ts：那里还会合并插件命令与 MCP prompt。
 */
export function getCommands(cwd: string): Command[] {
  const byName = new Map<string, Command>()

  for (const command of [
    ...BUILTIN_COMMANDS,
    ...loadCommandDir(join(homedir(), CONFIG_DIR_NAME, 'commands'), 'user'),
    ...loadCommandDir(join(cwd, CONFIG_DIR_NAME, 'commands'), 'project'),
  ]) {
    byName.set(command.name, command)
    for (const alias of command.aliases ?? []) byName.set(alias, command)
  }

  return [...new Set(byName.values())]
}

// 本函数：按名字或别名查找命令。
export function findCommand(commands: Command[], name: string): Command | undefined {
  return commands.find(
    command => command.name === name || (command.aliases ?? []).includes(name),
  )
}

/**
 * Split "/review src/app.ts extra" into name and arguments.
 * Returns undefined when the line is not a command at all.
 * 把 "/review src/app.ts extra" 拆成命令名与参数；不是命令则返回 undefined。
 */
export function parseCommandLine(line: string): { name: string; args: string } | undefined {
  if (!line.startsWith('/')) return undefined
  const trimmed = line.slice(1)
  const space = trimmed.search(/\s/)
  return space === -1
    ? { name: trimmed, args: '' }
    : { name: trimmed.slice(0, space), args: trimmed.slice(space + 1).trim() }
}

/**
 * Load `<dir>/*.md` as prompt commands.
 * 把 `<dir>/*.md` 加载为提示词命令。
 *
 * A command file is frontmatter plus a body:
 * 命令文件 = frontmatter + 正文：
 *
 *     ---
 *     description: Review the current diff
 *     argument-hint: <path>
 *     ---
 *     Review the changes in $ARGUMENTS for correctness...
 *
 * `$ARGUMENTS` is replaced with whatever followed the command; `$1`, `$2` …
 * take individual whitespace-separated words.
 * `$ARGUMENTS` 替换为命令后的全部参数；`$1`、`$2` … 取按空白分隔的单个词。
 */
export function loadCommandDir(dir: string, source: 'user' | 'project'): PromptCommand[] {
  if (!existsSync(dir)) return []

  const commands: PromptCommand[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue
    try {
      commands.push(parseCommandFile(join(dir, file), source))
    } catch (error) {
      // A broken command file must not stop the other commands loading.
      // 单个命令文件损坏不应阻断其余命令的加载。
      console.error(`[mini-cc] skipping command ${file}: ${String(error)}`)
    }
  }
  return commands
}

// 本函数：把单个 markdown 文件解析成一条提示词命令。
export function parseCommandFile(path: string, source: 'user' | 'project'): PromptCommand {
  const raw = readFileSync(path, 'utf8')
  const { frontmatter, body } = splitFrontmatter(raw)

  return {
    type: 'prompt',
    name: String(frontmatter.name ?? basename(path, '.md')),
    description: String(frontmatter.description ?? `Custom command from ${basename(path)}`),
    argumentHint: frontmatter['argument-hint'] ? String(frontmatter['argument-hint']) : undefined,
    source,
    async getPrompt(args) {
      return substituteArguments(body, args)
    },
  }
}

// 本函数：切分 YAML frontmatter 与正文；无 frontmatter 时整篇即正文。
export function splitFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>
  body: string
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) return { frontmatter: {}, body: raw }
  try {
    const parsed = parseYaml(match[1]!) as Record<string, unknown> | null
    return { frontmatter: parsed ?? {}, body: match[2] ?? '' }
  } catch {
    // Malformed YAML: treat the whole file as the body rather than failing.
    // YAML 解析失败时退化为「整篇都是正文」，而不是报错。
    return { frontmatter: {}, body: raw }
  }
}

/** `$ARGUMENTS` gets everything; `$1`, `$2` … get individual words. */
/** `$ARGUMENTS` 取全部参数；`$1`、`$2` … 取单个词。 */
export function substituteArguments(template: string, args: string): string {
  const words = args.split(/\s+/).filter(Boolean)
  return template
    .replace(/\$ARGUMENTS/g, args)
    .replace(/\$(\d+)/g, (whole, index: string) => words[Number(index) - 1] ?? whole)
}
