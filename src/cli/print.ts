// 本文件：非交互（-p / 管道 / 无 TTY）模式：一次提问、纯文本输出、结束退出，权限默认全部拒绝。
import { stdin, stdout } from 'node:process'
import type { Settings } from '../utils/config.js'
import type { PermissionContext } from '../types/permissions.js'
import type { Message } from '../types/message.js'
import { query } from '../query.js'
import { getToolsWithAgent } from '../tools.js'
import { FileHistory } from '../utils/fileHistory.js'
import { createAppState } from '../state/appState.js'

// 本函数：以非交互方式跑一个回合，把流式文本直接写到 stdout。
/**
 * Non-interactive mode: one prompt in, plain text out, exit.
 * 非交互模式：输入一个提问，输出纯文本，然后退出。
 *
 * This exists for three reasons, and the third is the important one:
 *   1. `mini-cc -p "..."` for scripting
 *   2. piped stdin, so mini-cc composes with other tools
 *   3. Ink cannot start without a TTY, so this is also the graceful
 *      degradation path for CI and for `cmd < file`
 * 存在的三个理由，第三个最重要：
 *   1. `mini-cc -p "..."` 便于脚本化
 *   2. 支持管道 stdin，可与其他工具组合
 *   3. Ink 没有 TTY 就起不来，所以这也是 CI 与 `cmd < file` 的优雅降级路径
 *
 * Permissions are DENY-BY-DEFAULT here. There is no human to ask, and
 * auto-approving in a script is how an agent deletes a build server.
 * 这里权限默认拒绝：没有人可问；脚本里自动批准，正是代理删掉构建服务器的方式。
 */
export async function runPrintMode(
  settings: Settings,
  permissions: PermissionContext,
  prompt?: string,
): Promise<void> {
  const text = prompt ?? (await readAllStdin())
  if (!text.trim()) {
    stdout.write('No prompt given. Use -p "your prompt", or pipe text on stdin.\n')
    return
  }

  const messages: Message[] = [{ role: 'user', content: text.trim() }]
  const abortController = new AbortController()

  const iterator = query({
    messages,
    settings,
    tools: getToolsWithAgent(settings, permissions.mode),
    toolContext: {
      cwd: process.cwd(),
      abortController,
      readFileState: new Map(),
      sessionAllow: new Set(),
      permissions,
      fileHistory: new FileHistory(),
      messageIndex: () => messages.length,
      appState: createAppState(),
    },
    // No TTY means no human means no approval.
    // 没有 TTY 就没有人，也就没有批准。
    canUseTool: async () => false,
  })

  while (true) {
    const step = await iterator.next()
    if (step.done) {
      if (step.value.reason !== 'completed') {
        stdout.write(`\n[${step.value.reason}]\n`)
        process.exitCode = 1
      }
      return
    }
    if (step.value.type === 'text_delta') stdout.write(step.value.text)
  }
}

// 本函数：读尽 stdin；若是 TTY 且无管道输入则立即返回空串，避免永久挂起。
function readAllStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = ''
    stdin.setEncoding('utf8')
    stdin.on('data', chunk => (data += chunk))
    stdin.on('end', () => resolve(data))
    // A TTY with no piped input would hang here forever.
    // TTY 且没有管道输入时，这里会永久挂起。
    if (stdin.isTTY) resolve('')
  })
}
