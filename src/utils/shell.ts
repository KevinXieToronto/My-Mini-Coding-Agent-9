// 本文件：子进程执行工具——跑一条 shell 命令并收集输出，负责超时、截断与中断响应。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export type ShellResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  truncated: boolean
}

const MAX_OUTPUT_CHARS = 30_000

export type RunShellOptions = {
  command: string
  cwd: string
  timeoutMs: number
  signal: AbortSignal
  /**
   * 'bash' uses Git Bash; 'powershell' uses Windows PowerShell.
   * 'bash' 走 Git Bash；'powershell' 走 Windows PowerShell。
   */
  shell: 'bash' | 'powershell'
}

/**
 * Locate the Git Bash executable.
 * 定位 Git Bash 可执行文件。
 *
 * On Windows the bare name `bash` is a trap: PATH resolves it to
 * C:\Windows\System32\bash.exe, which is the WSL launcher, not Git Bash. On a
 * machine with no WSL distro installed every command then dies with
 * "execvpe(/bin/bash) failed", which looks like a broken tool rather than a
 * misresolved binary. So we look for Git Bash by path and only fall back to
 * PATH off Windows, where `bash` means what it says.
 * Windows 上直接用 `bash` 是个陷阱：PATH 会解析到 C:\Windows\System32\bash.exe，
 * 那是 WSL 启动器而非 Git Bash。未装 WSL 发行版时，每条命令都会以
 * "execvpe(/bin/bash) failed" 告终，看起来像工具坏了，实则是解析错了程序。
 * 因此在 Windows 上按路径查找 Git Bash，仅在非 Windows 平台回落到 PATH。
 */
// 本函数：返回 Git Bash 的可执行路径；找不到时返回 null 由调用方给出可操作的报错。
export function resolveBash(): string | null {
  if (process.platform !== 'win32') return 'bash'

  // MINI_CC_BASH is the escape hatch for a non-standard Git install.
  // MINI_CC_BASH 是非标准 Git 安装位置的逃生口。
  const candidates = [
    process.env.MINI_CC_BASH,
    process.env.ProgramFiles && `${process.env.ProgramFiles}\\Git\\bin\\bash.exe`,
    process.env['ProgramFiles(x86)'] && `${process.env['ProgramFiles(x86)']}\\Git\\bin\\bash.exe`,
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`,
  ].filter((path): path is string => Boolean(path))

  return candidates.find(path => existsSync(path)) ?? null  // 按候选顺序取第一个真实存在的路径；环境变量为空的候选项已在上面被滤掉
}

const BASH_NOT_FOUND =
  'Git Bash was not found. On Windows the `bash` on PATH is the WSL launcher, not Git Bash. ' +
  'Install Git for Windows, or set MINI_CC_BASH to the full path of bash.exe. ' +
  'The PowerShell tool works right now and can run this instead.'

/**
 * Run a command in a child process and collect its output.
 * 在子进程中执行命令并收集其输出。
 *
 * Three things every agent shell tool must do, and most first attempts miss:
 *   1. TIME OUT. A command that waits for input hangs the agent forever.
 *   2. TRUNCATE. A 40 MB build log will blow the context window.
 *   3. RESPECT THE ABORT SIGNAL, so Ctrl+C actually kills the child.
 * 代理的 shell 工具必做三件事，而初版实现大多漏掉：
 *   1. 超时——等输入的命令会把代理永久挂住。
 *   2. 截断——40 MB 的构建日志会撑爆上下文窗口。
 *   3. 响应中断信号——这样 Ctrl+C 才真能杀掉子进程。
 *
 * We also merge stderr into the result rather than discarding it: for a failing
 * command, stderr IS the answer the model needs.
 * stderr 也并入结果而非丢弃：命令失败时，stderr 才是模型要的答案。
 */
// 本函数：在子进程中执行一条命令，带超时、输出截断与中断支持，返回结构化结果。
// 整体流程：1 解析出可执行文件（bash 需定位 Git Bash）→ 2 找不到就在 spawn 前失败并给出可操作提示
//          → 3 按 shell 种类拼出可执行文件与参数 → 4 起子进程，stdin 一律关闭
//          → 5 收集输出并按总量上限截断 → 6 挂超时器与中断监听，两者都直接杀进程
//          → 7 收尾：清定时器、摘监听器、兑现结构化结果。
export function runShell(options: RunShellOptions): Promise<ShellResult> {
  const { command, cwd, timeoutMs, signal, shell } = options

  // 步骤 1：解析可执行文件。
  const bashPath = shell === 'bash' ? resolveBash() : null

  // Fail before spawning, with an actionable message. Spawning WSL instead
  // "succeeds" and then exits 1, which reads as a failing command — the model
  // has no way to tell that the shell itself was wrong.
  // 在 spawn 之前就失败，并给出可操作的提示。误起 WSL 会「启动成功」再以 1 退出，
  // 看起来像命令本身失败，模型根本无从判断是 shell 选错了。
  // 步骤 2：Git Bash 缺失时提前失败。
  if (shell === 'bash' && bashPath === null) {
    return Promise.resolve({
      stdout: '',
      stderr: BASH_NOT_FOUND,
      exitCode: null,
      timedOut: false,
      truncated: false,
    })
  }

  // 步骤 3：拼出可执行文件与参数。
  const [file, args] =
    shell === 'bash'
      ? [bashPath as string, ['-c', command]]
      : ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]]  // -NoProfile 跳过用户配置以免污染环境，-NonInteractive 让任何提示直接报错而不是把我们挂住

  return new Promise<ShellResult>(resolve => {
    // 步骤 4：起子进程。
    const child = spawn(file, args, {
      cwd,
      // Never inherit stdin: an interactive prompt would hang us forever.
      // 绝不继承 stdin：交互式提示会把我们永久挂住。
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false

    // 步骤 5：收集输出并限量。
    // 本函数：把一段输出追加到 stdout/stderr，总量超上限则只记截断标记。
    const append = (target: 'out' | 'err', chunk: string): void => {
      if (stdout.length + stderr.length > MAX_OUTPUT_CHARS) {  // 按两股输出的总量设限，只置标记不再累积，内存与上下文都不会被长日志撑爆
        truncated = true
        return
      }
      if (target === 'out') stdout += chunk
      else stderr += chunk
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => append('out', String(chunk)))
    child.stderr.on('data', chunk => append('err', String(chunk)))

    // 步骤 6：超时与中断，两条路都是杀进程。
    const timer = setTimeout(() => {  // 先置标记再杀进程：随后的 close 事件才知道这次退出是超时所致，而非命令自己失败
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    // 本函数：中断信号到来时杀掉子进程。
    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    signal.addEventListener('abort', onAbort, { once: true })

    // 步骤 7：收尾。
    // 本函数：收尾——清理定时器与监听器，并兑现结果。
    const finish = (exitCode: number | null): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)  // 结算时摘掉监听器，避免长会话中一次次调用累积泄漏
      resolve({ stdout, stderr, exitCode, timedOut, truncated })
    }

    child.on('error', error => {  // spawn 本身失败（可执行文件不存在等），把原因并进 stderr 交给模型，退出码用 null 表示「没跑起来」
      stderr += `\nFailed to start ${file}: ${error.message}`
      finish(null)
    })
    child.on('close', code => finish(code))  // error 之后通常还会再来一次 close，但 Promise 只兑现一次，重复调用无害
  })
}

/**
 * Assemble the text the model sees for a finished command.
 * 拼装命令结束后交给模型的文本。
 */
// 本函数：把 ShellResult 拼成模型可读的文本，附带截断、超时与退出码提示。
export function formatShellResult(result: ShellResult): string {
  const parts: string[] = []
  if (result.stdout.trim()) parts.push(result.stdout.trimEnd())
  if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trimEnd()}`)
  if (result.truncated) parts.push(`[output truncated at ${MAX_OUTPUT_CHARS} characters]`)
  if (result.timedOut) parts.push('[command timed out and was killed]')
  if (result.exitCode !== 0 && result.exitCode !== null) {  // null 表示被杀（超时或中断），已由上面的提示说明，不再重复报退出码
    parts.push(`[exit code ${result.exitCode}]`)
  }
  return parts.length > 0 ? parts.join('\n') : '[no output, exit code 0]'
}
