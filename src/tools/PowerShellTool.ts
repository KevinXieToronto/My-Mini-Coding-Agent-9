// 本文件：PowerShell 工具——执行 Windows PowerShell 命令，用于 dotnet、注册表、服务等原生场景。
import { z } from 'zod'
import { buildTool } from '../Tool.js'
import { formatShellResult, runShell } from '../utils/shell.js'

const DEFAULT_TIMEOUT_MS = 120_000

// 无需询问即可执行的只读前缀名单（cmdlet 以动词开头，故按前缀匹配即可）。
const READ_ONLY_PREFIXES = [
  'Get-', 'Test-Path', 'Resolve-Path', 'Select-String', 'Measure-Object',
  'git status', 'git log', 'git diff', 'dotnet --version', 'node --version',
]

// 本函数：判断整条 PowerShell 命令是否只读——每个子命令都必须命中只读前缀名单。
function isReadOnlyCommand(command: string): boolean {
  const parts = command
    .split(/;|\|\||&&/)
    .map(part => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return false
  return parts.every(part => READ_ONLY_PREFIXES.some(prefix => part.startsWith(prefix)))
}

const schema = z.strictObject({
  command: z.string().describe('The PowerShell command to run.'),
  description: z.string().optional().describe('One short sentence describing what this does.'),
  timeout: z.number().int().min(1000).max(600_000).optional().describe('Timeout in milliseconds.'),
})

/**
 * Run a command through Windows PowerShell.
 * 经 Windows PowerShell 执行命令。
 *
 * Having both Bash and PowerShell is not redundancy — it is what makes the
 * agent useful on Windows. Native tooling (dotnet, winget, the registry,
 * scheduled tasks) is PowerShell-shaped, and translating it into Git Bash is a
 * losing game.
 * 同时提供 Bash 与 PowerShell 不是冗余，而是让代理在 Windows 上真正可用：
 * dotnet、winget、注册表、计划任务等原生工具本就是 PowerShell 形态，硬翻成 Git Bash 是白费劲。
 *
 * The description carries the cmdlet translations because models default to
 * Unix commands and then fail confusingly.
 * description 里写上 cmdlet 对照，因为模型默认写 Unix 命令，然后以莫名其妙的方式失败。
 */
// 本工具：PowerShell——执行 Windows 原生命令，只读命令直接放行，其余请求人类批准。
export const PowerShellTool = buildTool({
  name: 'PowerShell',
  description:
    'Run a Windows PowerShell command and return its output. Use this for Windows-native ' +
    'work: dotnet, winget, services, the registry (HKLM:\\ style paths), scheduled tasks. ' +
    'Unix commands do NOT exist here — use Get-Content instead of cat, Get-ChildItem ' +
    'instead of ls, $env:NAME instead of $NAME. Runs with -NonInteractive and no stdin, ' +
    'so never use Read-Host or anything that prompts.',
  inputSchema: schema,

  isReadOnly: input => isReadOnlyCommand(input.command),
  isConcurrencySafe: input => isReadOnlyCommand(input.command),

  renderCall: input => `PowerShell(${input.command})`,
  renderResult: result => {
    const data = result.data as { exitCode: number | null } | undefined
    return data?.exitCode === 0 ? 'ok' : `exit ${data?.exitCode ?? '?'}`
  },

  // 本函数：工具专属权限判定——只读命令放行，其余询问人类。
  checkPermissions(input) {
    if (isReadOnlyCommand(input.command)) return { behavior: 'allow' }
    return { behavior: 'ask', message: `PowerShell: ${input.command}` }
  },

  // 本函数：执行命令并把格式化输出与退出码回传。
  async execute(input, ctx) {
    const result = await runShell({
      command: input.command,
      cwd: ctx.cwd,
      timeoutMs: input.timeout ?? DEFAULT_TIMEOUT_MS,
      signal: ctx.abortController.signal,
      shell: 'powershell',
    })
    return { result: formatShellResult(result), data: { exitCode: result.exitCode } }
  },
})
