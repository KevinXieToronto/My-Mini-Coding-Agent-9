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
export function userConfigDir(): string {
  return join(homedir(), CONFIG_DIR_NAME)
}

export function userSettingsPath(): string {
  return join(userConfigDir(), 'settings.json')
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, 'settings.json')
}

function readJSONIfExists(path: string): Partial<Settings> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>
  } catch (error) {
    console.error(`[mini-cc] ignoring malformed settings at ${path}: ${String(error)}`)
    return {}
  }
}

export function loadSettings(cwd: string = process.cwd()): Settings {
  return {
    ...DEFAULTS,
    ...readJSONIfExists(userSettingsPath()),
    ...readJSONIfExists(projectSettingsPath(cwd)),
  }
}

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
export function loadEnvFile(cwd: string = process.cwd()): void {
  const path = join(cwd, '.env')
  if (!existsSync(path)) return
  process.loadEnvFile(path)
}
