// 本文件：Bash 工具——经 Git Bash 执行 shell 命令，并按命令是否只读决定要不要征求许可。
import { z } from 'zod'
import { buildTool } from '../Tool.js'
import { formatShellResult, runShell } from '../utils/shell.js'

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Commands we are willing to run without asking, because they only read.
 * Deliberately short and deliberately exact-prefix — see isReadOnlyCommand.
 * 无需询问即可执行的命令：它们只读。
 * 名单刻意保持短小，且刻意按「精确前缀」匹配——参见 isReadOnlyCommand。
 */
const READ_ONLY_PREFIXES = [
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git remote -v',
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'which', 'echo',
  'node --version', 'npm --version', 'npm ls', 'tsc --noEmit',
  // Short forms too — models reach for `node -v` far more often than the long
  // spelling, and prompting for a version check trains the user to stop reading
  // the prompts.
  // 短选项同样列入：模型写 `node -v` 远多于长写法，
  // 为一次版本查询弹批准框，只会让用户养成不看提示的习惯。
  'node -v', 'npm -v', 'git --version', 'git -v', 'python --version', 'python -V',
]

/**
 * Splitting on the operators that chain commands. This is the crudest possible
 * version and Chapter 9 replaces it with a real parser — but even this stops
 * the obvious `git status && rm -rf /` bypass, which a naive prefix check
 * would wave straight through.
 * 按串联命令的操作符切分。这是最粗糙的版本，第 9 章会换成真正的解析器——
 * 但即便如此也已挡住 `git status && rm -rf /` 这类绕过，而朴素的前缀检查会直接放行。
 */
// 本函数：按 && || ; | 切分命令串，返回去空的子命令列表。
export function splitCommand(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map(part => part.trim())
    .filter(Boolean)
}

// 本函数：判断整条命令是否只读——每个子命令都必须命中只读前缀名单。
export function isReadOnlyCommand(command: string): boolean {
  const parts = splitCommand(command)
  if (parts.length === 0) return false
  // EVERY subcommand must be read-only, or the whole thing is not.
  // 必须「每个」子命令都只读，否则整条命令都不算只读。
  return parts.every(part => READ_ONLY_PREFIXES.some(prefix => isPrefixOf(prefix, part)))
}

/**
 * `git log` matches "git log --oneline" but not "git logout".
 * `git log` 能匹配 "git log --oneline"，但匹配不到 "git logout"。
 */
// 本函数：按词边界判断 prefix 是否为 command 的命令前缀。
function isPrefixOf(prefix: string, command: string): boolean {
  if (command === prefix) return true
  return command.startsWith(`${prefix} `)
}

const schema = z.strictObject({
  command: z.string().describe('The shell command to run.'),
  description: z
    .string()
    .optional()
    .describe('One short sentence, active voice, describing what this does. Shown to the user.'),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe('Timeout in milliseconds. Default 120000, max 600000.'),
})

/**
 * Run a command through Git Bash.
 * 经 Git Bash 执行命令。
 *
 * Note isReadOnly is computed FROM THE INPUT. `git status` needs no approval;
 * `git push` does. That is why the Tool contract passes the input to
 * isReadOnly and isConcurrencySafe rather than declaring them as constants.
 * 注意 isReadOnly 是「由入参算出」的：`git status` 无需批准，`git push` 需要。
 * 这正是 Tool 契约把入参传给 isReadOnly 与 isConcurrencySafe、而非声明为常量的原因。
 */
// 本工具：Bash——经 Git Bash 执行命令，只读命令直接放行，其余请求人类批准。
export const BashTool = buildTool({
  name: 'Bash',
  description:
    'Run a shell command through Git Bash (POSIX sh) and return its output. ' +
    'Use forward slashes and Unix syntax. Prefer the dedicated Read/Edit/Glob/Grep ' +
    'tools for file work — they are faster and safer than shelling out. ' +
    'Commands time out after 2 minutes by default. Interactive commands are not ' +
    'supported: stdin is closed, so anything that prompts will fail.',
  inputSchema: schema,

  isReadOnly: input => isReadOnlyCommand(input.command),
  // A read-only command can safely run alongside others; a mutating one cannot.
  // 只读命令可与其他调用并行；会改动状态的不行。
  isConcurrencySafe: input => isReadOnlyCommand(input.command),

  renderCall: input => `Bash(${input.command})`,
  renderResult: result => {
    const data = result.data as { exitCode: number | null } | undefined
    return data?.exitCode === 0 ? 'ok' : `exit ${data?.exitCode ?? '?'}`
  },

  // 本函数：工具专属权限判定——只读命令放行，其余询问人类。
  checkPermissions(input) {
    if (isReadOnlyCommand(input.command)) return { behavior: 'allow' }
    return { behavior: 'ask', message: `Bash: ${input.command}` }
  },

  // 本函数：执行命令并把格式化输出与退出码回传。
  async execute(input, ctx) {
    const result = await runShell({
      command: input.command,
      cwd: ctx.cwd,
      timeoutMs: input.timeout ?? DEFAULT_TIMEOUT_MS,
      signal: ctx.abortController.signal,
      shell: 'bash',
    })
    return { result: formatShellResult(result), data: { exitCode: result.exitCode } }
  },
})
