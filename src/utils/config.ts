import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR_NAME } from '../constants/product.js'

/**
 * Settings are layered, lowest precedence first:
 *
 *   built-in defaults  <  user settings  <  project settings  <  CLI flags
 *
 * cf. src/utils/settings/ in the Claude Code tree, which layers five sources
 * (defaults, user, project, local, managed policy).
 */
export type Settings = {
  model: string
  baseURL?: string
  maxTurns: number
  /** 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' — grows in Ch.9 */
  permissionMode: string
}

const DEFAULTS: Settings = {
  model: 'gpt-4.1-mini',
  maxTurns: 40,
  permissionMode: 'default',
}

/** %USERPROFILE%\.mini-cc */
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
 */
export function loadEnvFile(cwd: string = process.cwd()): void {
  const path = join(cwd, '.env')
  if (!existsSync(path)) return
  process.loadEnvFile(path)
}
