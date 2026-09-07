// 本文件：设置的分层加载与保存，以及 .env 环境变量的载入。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR_NAME } from '../constants/product.js'

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
  /**
   * 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' — grows in Ch.9
   * 权限模式，第 9 章扩充。
   */
  permissionMode: string
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

// 本函数：按「默认值 < 用户设置 < 项目设置」分层合并出最终设置。
export function loadSettings(cwd: string = process.cwd()): Settings {
  return {
    ...DEFAULTS,
    ...readJSONIfExists(userSettingsPath()),
    ...readJSONIfExists(projectSettingsPath(cwd)),
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
