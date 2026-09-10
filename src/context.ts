// 本文件：会话上下文的采集处，负责收集 MINI.md 指令、git 状态与环境信息，供动态提示词使用。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform, release } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { PROJECT_MEMORY_FILE, CONFIG_DIR_NAME } from './constants/product.js'
import { toAbsolute, toDisplayPath } from './utils/paths.js'
import { loadSkills, renderSkillsSection, visibleSkills } from './skills/loadSkills.js'

/**
 * Assemble everything the model needs to know about *this* project and *this*
 * machine, as opposed to the fixed instructions in constants/prompts.ts.
 * 汇集模型需要知道的「本项目 / 本机器」信息，与 constants/prompts.ts 中的固定指令相对。
 *
 * cf. src/context.ts and src/utils/claudemd.ts in the Claude Code tree.
 * 参见 Claude Code 的 src/context.ts 与 src/utils/claudemd.ts。
 */

const MAX_INSTRUCTION_BYTES = 32_000
const MAX_IMPORT_DEPTH = 3

// 本函数：自用户目录与文件系统根目录一路向下，收集所有 MINI.md 指令文件路径。
/**
 * Find MINI.md files from the home directory down to the working directory.
 * 从用户目录一路向下到工作目录，查找 MINI.md 文件。
 *
 * Ordering is deliberate: the most general file comes FIRST and the most
 * specific LAST, so a project-level instruction naturally overrides a
 * user-level one when they conflict — later text wins in a prompt.
 * 顺序是刻意的：最通用的在前、最具体的在后。冲突时项目级自然覆盖用户级——
 * 提示词中后出现的文本胜出。
 *
 * Claude Code does the same with four tiers (managed policy, user, project,
 * local) and also loads files just-in-time from directories a tool touches.
 * Claude Code 同样如此，分四层（托管策略、用户、项目、本地），
 * 并会在工具触及某目录时按需加载该目录的文件。
 */
export function findInstructionFiles(cwd: string): string[] {
  const found: string[] = []

  // User-level: %USERPROFILE%\.mini-cc\MINI.md
  // 用户级：%USERPROFILE%\.mini-cc\MINI.md
  const userFile = join(homedir(), CONFIG_DIR_NAME, PROJECT_MEMORY_FILE)
  if (existsSync(userFile)) found.push(userFile)

  // Walk from the filesystem root down to cwd, collecting as we go.
  // 从文件系统根目录向下走到 cwd，沿途收集。
  const { root } = parse(cwd)
  const chain: string[] = []
  let current = cwd
  while (true) {
    chain.unshift(current)
    if (current === root) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  for (const dir of chain) {
    for (const candidate of [
      join(dir, PROJECT_MEMORY_FILE),
      join(dir, CONFIG_DIR_NAME, PROJECT_MEMORY_FILE),
    ]) {
      if (existsSync(candidate) && !found.includes(candidate)) found.push(candidate)
    }
  }

  return found
}

// 本函数：读取全部指令文件、展开其中的 @ 导入，并按上限截断后拼成一段文本。
/** Read the instruction files and resolve `@path` imports inside them. */
/** 读取指令文件，并解析其中的 `@path` 导入。 */
export function loadProjectInstructions(cwd: string): string | undefined {
  const files = findInstructionFiles(cwd)
  if (files.length === 0) return undefined

  const sections = files.map(file => {
    const body = expandImports(readFileSync(file, 'utf8'), dirname(file), 0, new Set([file]))
    return `## From ${toDisplayPath(cwd, file)}\n\n${body.trim()}`
  })

  const joined = sections.join('\n\n')
  return joined.length > MAX_INSTRUCTION_BYTES
    ? `${joined.slice(0, MAX_INSTRUCTION_BYTES)}\n\n[instructions truncated]`
    : joined
}

// 本函数：递归展开指令文件中的 `@相对路径` 导入，并用 seen 集合防止循环导入。
/**
 * `@relative/path.md` on its own line pulls that file inline.
 * 单独成行的 `@relative/path.md` 会把该文件内联进来。
 *
 * The `seen` set is not paranoia: two files that import each other will hang
 * the CLI at startup, which is a miserable thing to debug.
 * `seen` 集合并非多虑：两个文件互相导入会让 CLI 启动时挂死，这种问题极难排查。
 */
function expandImports(text: string, baseDir: string, depth: number, seen: Set<string>): string {
  if (depth >= MAX_IMPORT_DEPTH) return text

  return text.replace(/^@([^\s]+)\s*$/gm, (whole, relativePath: string) => {
    const target = toAbsolute(baseDir, relativePath)
    if (seen.has(target) || !existsSync(target)) return whole
    seen.add(target)
    const body = readFileSync(target, 'utf8')
    return expandImports(body, dirname(target), depth + 1, seen)
  })
}

// 本函数：生成精简的 git 概览（分支、改动文件、近期提交），非仓库或无 git 时返回 undefined。
/**
 * A compact git summary. Cheap orientation: the model learns the branch and
 * what is dirty without spending a tool call on it.
 * 精简的 git 概览。低成本的方位感：模型无需花一次工具调用即可知道分支与哪些文件被改动。
 */
export function getGitStatus(cwd: string): string | undefined {
  const git = (args: string[]): string | undefined => {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim()
    } catch {
      return undefined
    }
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch) return undefined // not a repo, or git is not installed
  // 不是仓库，或未安装 git。

  const parts = [`Branch: ${branch}`]

  const status = git(['status', '--short'])
  if (status) {
    const lines = status.split('\n')
    const shown = lines.slice(0, 20).join('\n')
    parts.push(
      `Changed files:\n${shown}${lines.length > 20 ? `\n... and ${lines.length - 20} more` : ''}`,
    )
  } else {
    parts.push('Working tree clean')
  }

  const log = git(['log', '--oneline', '-5'])
  if (log) parts.push(`Recent commits:\n${log}`)

  return parts.join('\n')
}

/**
 * The per-session facts that feed the dynamic half of the system prompt.
 * 供系统提示词动态部分使用的、每会话一份的事实集合。
 */
export type SessionContext = {
  cwd: string
  platform: string
  today: string
  gitStatus?: string
  skillsSection?: string
  /**
   * Instructions the connected MCP servers shipped, already rendered.
   * 已连接 MCP 服务器自带的说明，已渲染成文。
   */
  mcpInstructions?: string
  projectInstructions?: string
}

// 本函数：每会话构建一次上下文（平台、日期、git 状态、项目指令），刻意不逐回合刷新以保住提示词缓存。
/**
 * Built once per session. Git status and MINI.md do change while you work, but
 * re-reading them every turn would break the prompt cache for a marginal
 * benefit — and the agent can always run `git status` itself.
 * 每会话构建一次。git 状态与 MINI.md 在工作中确会变化，但逐回合重读会打断提示词缓存，
 * 收益甚微——何况代理随时可以自己跑 `git status`。
 */
export function buildSessionContext(cwd: string, mcpInstructions?: string): SessionContext {
  return {
    cwd,
    platform: `${platform()} ${release()}`,
    today: new Date().toISOString().slice(0, 10),
    gitStatus: getGitStatus(cwd),
    // Nothing has been touched yet, so only the unconditional skills are
    // advertised — a conditional one costs nothing until it becomes relevant.
    // 此刻尚未触及任何文件，故只公布无条件技能——条件技能在变得相关前不花一分钱。
    skillsSection: renderSkillsSection(visibleSkills(loadSkills(cwd), [])),
    // Passed in rather than loaded here: connecting to a server is async and
    // happens before the UI mounts, while this function is synchronous.
    // 由外部传入而非在此加载：连接服务器是异步的、发生在 UI 挂载之前，而本函数是同步的。
    mcpInstructions: mcpInstructions?.trim() ? mcpInstructions : undefined,
    projectInstructions: loadProjectInstructions(cwd),
  }
}

// 本函数：展开用户输入里的 `@路径` 提及，把文件内容附在提示词末尾。
/**
 * Expand `@path` mentions in what the USER typed, inlining file contents.
 * 展开用户输入中的 `@path` 提及，把文件内容内联进来。
 *
 * Different from the import expansion above: this runs on each prompt, and it
 * is how "explain @src/query.ts" works without the model spending a Read call.
 * 与上面的导入展开不同：它在每次提问时运行，
 * 「解释一下 @src/query.ts」正是靠它省下模型的一次 Read 调用。
 */
export function expandUserMentions(text: string, cwd: string): string {
  const attachments: string[] = []

  for (const match of text.matchAll(/@([\w./\\-]+)/g)) {
    const path = toAbsolute(cwd, match[1]!)
    if (!existsSync(path)) continue
    try {
      const body = readFileSync(path, 'utf8').slice(0, 20_000)
      attachments.push(`### ${match[1]}\n\n\`\`\`\n${body}\n\`\`\``)
    } catch {
      // A directory or an unreadable file: leave the mention as plain text.
      // 目录或不可读文件：保持该提及为纯文本。
    }
  }

  if (attachments.length === 0) return text
  return `${text}\n\n<!-- files referenced above -->\n${attachments.join('\n\n')}`
}
