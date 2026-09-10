// 本文件：技能的发现与加载——扫描技能目录、解析 SKILL.md，并只把名称与描述渲染进系统提示词。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import picomatch from 'picomatch'
import { splitFrontmatter } from '../commands.js'
import { CONFIG_DIR_NAME } from '../constants/product.js'

/**
 * Skills: reusable instructions the model can pull in on demand.
 * 技能：模型可按需拉取的可复用指令。
 *
 * The mechanism is PROGRESSIVE DISCLOSURE. Only each skill's name and
 * description ship in the system prompt — maybe 30 tokens each. The body,
 * which may be thousands of tokens, is loaded only when the model invokes it.
 * 机制是「渐进式披露」：系统提示词里只放每个技能的名称与描述（各约 30 token）；
 * 动辄数千 token 的正文，只在模型真正调用时才加载。
 *
 * That is what makes skills scale. Fifty skills cost ~1,500 tokens of prompt
 * whether or not any of them is used, and you pay the real cost only for the
 * one that turns out to be relevant.
 * 这正是技能能够规模化的原因：五十个技能无论用不用都只占约 1,500 token，
 * 真正的开销只为那个确实相关的技能支付。
 *
 * On disk:
 * 磁盘布局：
 *   <skills-dir>/<skill-name>/SKILL.md
 *
 * cf. src/skills/loadSkillsDir.ts in the Claude Code tree.
 * 参见 Claude Code 源码树的 src/skills/loadSkillsDir.ts。
 */

export type Skill = {
  name: string
  /** THE most important field: how the model decides whether to load this. */
  /** 最重要的字段：模型据此判断要不要加载本技能。 */
  description: string
  /** The full instructions. Loaded eagerly from disk, sent only on invoke. */
  /** 完整指令。启动时即从磁盘读入，但仅在被调用时才发给模型。 */
  body: string
  source: 'user' | 'project'
  path: string
  /**
   * Glob patterns. When present, the skill is hidden until the agent touches a
   * matching file — a conditional skill.
   * glob 模式。存在时，技能会隐藏到代理触及匹配文件为止——即「条件技能」。
   */
  paths?: string[]
  /** Tools the skill needs. Advisory; we surface it in the prompt. */
  /** 技能需要的工具。仅作提示，会在提示词中呈现出来。 */
  allowedTools?: string[]
}

// 本函数：返回技能搜索目录（用户级与项目级），顺序即优先级由低到高。
export function skillDirs(cwd: string): { dir: string; source: 'user' | 'project' }[] {
  return [
    { dir: join(homedir(), CONFIG_DIR_NAME, 'skills'), source: 'user' as const },
    { dir: join(cwd, CONFIG_DIR_NAME, 'skills'), source: 'project' as const },
  ]
}

// 本函数：扫描各技能目录，解析出全部技能并按名称排序返回。
export function loadSkills(cwd: string): Skill[] {
  const byName = new Map<string, Skill>()

  for (const { dir, source } of skillDirs(cwd)) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      const skillFile = join(dir, entry, 'SKILL.md')
      if (!existsSync(skillFile) || !statSync(join(dir, entry)).isDirectory()) continue
      try {
        const skill = parseSkill(skillFile, entry, source)
        // Project skills override user skills of the same name.
        // 同名时项目级技能覆盖用户级技能。
        byName.set(skill.name, skill)
      } catch (error) {
        console.error(`[mini-cc] skipping skill ${entry}: ${String(error)}`)
      }
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// 本函数：把单个 SKILL.md 解析成 Skill 对象；缺少 description 即视为无效技能。
export function parseSkill(path: string, dirName: string, source: 'user' | 'project'): Skill {
  const { frontmatter, body } = splitFrontmatter(readFileSync(path, 'utf8'))

  const description = String(frontmatter.description ?? '').trim()
  if (!description) {
    // Without a description the model has no basis to choose the skill, so it
    // would sit in the prompt costing tokens and never be used.
    // 没有描述，模型就无从选择该技能——它只会占着 token 却永远不被使用。
    throw new Error('SKILL.md needs a `description` in its frontmatter')
  }

  return {
    name: String(frontmatter.name ?? dirName),
    description,
    body: body.trim(),
    source,
    path,
    paths: toStringArray(frontmatter.paths),
    allowedTools: toStringArray(frontmatter['allowed-tools']),
  }
}

// 本函数：把 frontmatter 中的字符串或数组字段统一规整为字符串数组。
function toStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return [value]
  return undefined
}

// 本函数：按已触及的文件路径筛出当前应当对模型可见的技能。
/**
 * Which skills should be advertised right now?
 * 此刻应当对模型公布哪些技能？
 *
 * An unconditional skill is always listed. A conditional one (with `paths`)
 * appears only once the agent has touched a matching file — so a
 * Python-specific skill costs nothing in a TypeScript repo.
 * 无条件技能始终列出；带 `paths` 的条件技能，要等代理触及匹配文件后才出现——
 * 于是 Python 专用技能在 TypeScript 仓库里一分钱不花。
 */
export function visibleSkills(skills: Skill[], touchedPaths: Iterable<string>): Skill[] {
  const touched = [...touchedPaths]
  return skills.filter(skill => {
    if (!skill.paths?.length) return true
    const isMatch = picomatch(skill.paths, { dot: true })
    return touched.some(path => isMatch(path))
  })
}

// 本函数：把技能清单渲染成系统提示词区块——只写名称与描述，正文留在磁盘上。
/**
 * The prompt section. Descriptions only — the bodies stay on disk.
 * This function IS the progressive-disclosure mechanism.
 * 提示词区块：只含描述，正文留在磁盘。本函数就是「渐进式披露」机制本身。
 */
export function renderSkillsSection(skills: Skill[]): string {
  if (skills.length === 0) return ''
  return [
    '# Skills',
    '',
    'These are packaged instructions for specific kinds of task. When one applies,',
    'call the Skill tool with its name FIRST — before starting the work — and follow',
    'what it says in place of your default approach.',
    '',
    ...skills.map(skill => `- ${skill.name}: ${skill.description}`),
  ].join('\n')
}
