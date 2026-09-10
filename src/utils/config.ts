// 本文件：设置的分层加载与保存，以及 .env 环境变量的载入。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { CONFIG_DIR_NAME } from '../constants/product.js'
import type { PermissionContext, PermissionMode } from '../types/permissions.js'
import type { HookEvent, HookMatcher, HooksConfig } from '../types/hooks.js'
import { HOOK_EVENTS } from '../types/hooks.js'
import { parseRules } from './permissions.js'

/**
 * Settings are layered, lowest precedence first:
 * 设置分层叠加，优先级由低到高：
 *
 *   built-in defaults  <  user settings  <  project settings  <  CLI flags
 *   内置默认值  <  用户设置  <  项目设置  <  命令行参数
 *
 * cf. src/utils/settings/ in the Claude Code tree, which layers five sources
 * (defaults, user, project, local, managed policy).
 * 参见 Claude Code 的 src/utils/settings/：叠加五个来源（默认、用户、项目、本地、受管策略）。
 */
export type Settings = {
  model: string
  baseURL?: string
  maxTurns: number
  permissionMode: PermissionMode
  /**
   * Rule strings, e.g. { deny: ['Bash(rm *)'], allow: ['Bash(npm test)'] }
   * 规则字符串，如 { deny: ['Bash(rm *)'], allow: ['Bash(npm test)'] }
   */
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] }
  additionalDirectories?: string[]
  /**
   * Lifecycle hooks, keyed by event. See src/types/hooks.ts.
   * 生命周期钩子，按事件分组。参见 src/types/hooks.ts。
   */
  hooks?: HooksConfig
}

const DEFAULTS: Settings = {
  model: 'gpt-4.1-mini',
  maxTurns: 40,
  permissionMode: 'default',
}

/**
 * %USERPROFILE%\.mini-cc
 * 用户配置目录。
 */
// 本函数：返回用户级配置目录路径。
export function userConfigDir(): string {
  return join(homedir(), CONFIG_DIR_NAME)
}

// 本函数：返回用户级 settings.json 的路径。
export function userSettingsPath(): string {
  return join(userConfigDir(), 'settings.json')
}

// 本函数：返回项目级 settings.json 的路径。
export function projectSettingsPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, 'settings.json')
}

// 本函数：读取并解析 JSON 设置文件；文件不存在或格式非法时返回空对象。
function readJSONIfExists(path: string): Partial<Settings> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>
  } catch (error) {
    console.error(`[mini-cc] ignoring malformed settings at ${path}: ${String(error)}`)
    return {}
  }
}

/**
 * Layered load. Note `permissions` is MERGED rather than replaced: a project
 * settings file must not be able to drop the deny rules a user set globally.
 * 分层加载。注意 `permissions` 是「合并」而非「覆盖」：
 * 项目设置绝不能把用户全局设的 deny 规则弄丢。
 */
// 本函数：按「默认值 < 用户设置 < 项目设置」分层合并设置，其中权限规则与附加目录取并集。
export function loadSettings(cwd: string = process.cwd()): Settings {
  const user = readJSONIfExists(userSettingsPath())
  const project = readJSONIfExists(projectSettingsPath(cwd))
  return {
    ...DEFAULTS,
    ...user,
    ...project,
    permissions: {
      allow: [...(user.permissions?.allow ?? []), ...(project.permissions?.allow ?? [])],
      deny: [...(user.permissions?.deny ?? []), ...(project.permissions?.deny ?? [])],
      ask: [...(user.permissions?.ask ?? []), ...(project.permissions?.ask ?? [])],
    },
    additionalDirectories: [
      ...(user.additionalDirectories ?? []),
      ...(project.additionalDirectories ?? []),
    ],
    hooks: mergeHooks(user.hooks, project.hooks),
  }
}

/**
 * Hooks merge per event for the same reason permission rules do: a project
 * file must be able to ADD a guard, never to quietly drop one the user set
 * globally. Hooks subtract capability, so losing one is the dangerous
 * direction.
 * 钩子按事件合并，理由与权限规则相同：项目级配置可以「加」一道守卫，
 * 却绝不能悄悄丢掉用户在全局设置的那道。钩子做减法，丢一个才是危险的方向。
 */
// 本函数：把用户级与项目级的钩子配置按事件逐项合并（用户级在前）。
function mergeHooks(user?: HooksConfig, project?: HooksConfig): HooksConfig {
  const merged: HooksConfig = {}
  for (const event of HOOK_EVENTS) {
    const entries: HookMatcher[] = [...(user?.[event] ?? []), ...(project?.[event] ?? [])]
    if (entries.length) merged[event as HookEvent] = entries
  }
  return merged
}

/**
 * Build the runtime permission context from settings plus CLI overrides.
 * 由设置加上命令行覆盖，构建运行期的权限上下文。
 */
// 本函数：合成运行期权限上下文——模式、按来源解析的规则列表、以及解析为绝对路径的附加目录。
export function buildPermissionContext(
  settings: Settings,
  cwd: string,
  overrides: { mode?: PermissionMode; addDirs?: string[] } = {},
): PermissionContext {
  const userRaw = readJSONIfExists(userSettingsPath()).permissions
  const projectRaw = readJSONIfExists(projectSettingsPath(cwd)).permissions
  return {
    mode: overrides.mode ?? settings.permissionMode,
    rules: [
      ...parseRules(userRaw, 'userSettings'),
      ...parseRules(projectRaw, 'projectSettings'),
    ],
    additionalDirectories: [
      ...(settings.additionalDirectories ?? []),
      ...(overrides.addDirs ?? []),
    ].map(dir => resolve(cwd, dir)),
    cwd,
  }
}

// 本函数：把补丁合并进用户级设置并写回磁盘。
export function saveUserSettings(patch: Partial<Settings>): void {
  mkdirSync(userConfigDir(), { recursive: true })
  const merged = { ...readJSONIfExists(userSettingsPath()), ...patch }
  writeFileSync(userSettingsPath(), JSON.stringify(merged, null, 2) + '\n', 'utf8')
}

/**
 * Load .env from the project root if present. Node 22 ships loadEnvFile, so we
 * need no dotenv dependency.
 * 若项目根目录存在 .env 则加载。Node 22 自带 loadEnvFile，无需 dotenv 依赖。
 */
// 本函数：若项目根存在 .env，用 Node 内置能力加载其中的环境变量。
export function loadEnvFile(cwd: string = process.cwd()): void {
  const path = join(cwd, '.env')
  if (!existsSync(path)) return
  process.loadEnvFile(path)
}
