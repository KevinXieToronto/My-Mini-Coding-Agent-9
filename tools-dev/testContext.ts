// 本文件：为冒烟脚本集中构建 ToolContext 的测试辅助，避免每章都改一遍每个脚本。
import type { ToolContext } from '../src/Tool.js'
import type { PermissionMode, PermissionRule } from '../src/types/permissions.js'
import { FileHistory } from '../src/utils/fileHistory.js'
import { parseRules } from '../src/utils/permissions.js'

/**
 * One place that knows how to build a ToolContext for a test.
 * 唯一知道如何为测试构建 ToolContext 的地方。
 *
 * ToolContext grows almost every chapter. Without this helper every smoke test
 * breaks on every chapter, which trains you to ignore type errors — exactly the
 * habit you do not want.
 * ToolContext 几乎每章都会长大。没有这个辅助，每章都要修所有冒烟脚本，
 * 久而久之就会习惯性忽略类型错误——正是最该避免的习惯。
 */
// 本函数：构建一个可配置的测试用 ToolContext。
export function makeContext(
  options: {
    cwd?: string
    mode?: PermissionMode
    rules?: { allow?: string[]; deny?: string[]; ask?: string[] }
    additionalDirectories?: string[]
    messageIndex?: number
  } = {},
): ToolContext {
  const cwd = options.cwd ?? process.cwd()
  const rules: PermissionRule[] = parseRules(options.rules, 'projectSettings')
  return {
    cwd,
    abortController: new AbortController(),
    readFileState: new Map(),
    sessionAllow: new Set(),
    permissions: {
      mode: options.mode ?? 'default',
      rules,
      additionalDirectories: options.additionalDirectories ?? [],
      cwd,
    },
    fileHistory: new FileHistory(),
    messageIndex: () => options.messageIndex ?? 0,
  }
}
