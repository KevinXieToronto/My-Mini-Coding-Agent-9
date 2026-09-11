// 本文件：/doctor 自诊断命令——逐项检查运行环境、密钥、设置、技能、钩子、MCP、指令文件与外部程序。
import { execFileSync } from 'node:child_process'
import type { Command } from '../types/command.js'
import { PRODUCT_NAME, VERSION } from '../constants/product.js'
import { loadMcpConfig } from '../services/mcp/config.js'
import { listSessions } from '../utils/sessionStorage.js'
import { toDisplayPath } from '../utils/paths.js'

/**
 * One line of the report. `ok` drives the marker, nothing else — a check that
 * is merely informational reports ok:true and says the interesting part in
 * `detail`.
 * 报告中的一行。`ok` 只决定行首标记；纯信息性的检查一律 ok:true，
 * 真正有意思的内容写在 `detail` 里。
 */
type Check = { label: string; ok: boolean; detail: string }

/**
 * Self-diagnosis.
 * 自诊断。
 *
 * Every chapter added a file that must be found, a binary that must exist, or
 * an environment variable that must be set. `/doctor` answers "why is this not
 * working" without the user having to know which chapter to suspect.
 * 每一章都新增了「必须找得到的文件」「必须存在的程序」或「必须设置的环境变量」。
 * `/doctor` 回答「为什么它不工作」——用户不必先猜是哪一章出了问题。
 *
 * It reports, and never repairs. A diagnostic that also writes files is a
 * diagnostic you stop trusting to tell you the truth about the current state.
 * 它只报告，从不修理。会顺手写文件的诊断工具，你就不再敢信它讲的是当前真实状态。
 *
 * cf. src/commands/doctor and src/screens/Doctor.tsx.
 * 参见 src/commands/doctor 与 src/screens/Doctor.tsx。
 */
// 本命令：/doctor，逐项体检并输出一份带 +/! 标记的纯文本报告。
// 整体流程：1 动态加载两个会成环的模块 → 2 查运行环境（Node 版本、密钥、baseURL、模型、权限模式）
//          → 3 查「由文件决定能力」的三处：技能、钩子、MCP 服务器
//          → 4 查 MINI.md 与会话记录 → 5 探 git 与 ripgrep 两个可选外部程序
//          → 6 按最长标签对齐，拼成一份报告返回。
export const doctor: Command = {
  type: 'local',
  name: 'doctor',
  description: 'Check the installation and configuration',
  async call(_args, ctx) {
    // Loaded here, not at the top: the skills loader reaches back into
    // commands.ts for its frontmatter parser, and commands.ts builds the
    // registry this command is part of. A static import would be a cycle, and
    // the cycle would bite at startup rather than here. Same remedy as /help.
    // 放在这里加载而非顶层：技能加载器要回头用 commands.ts 的 frontmatter 解析器，
    // 而 commands.ts 又要构建本命令所在的注册表。顶层 import 会成环，
    // 且会在启动时就出事、而不是在这里。与 /help 用的是同一招。
    // 步骤 1：动态加载，打破循环依赖。
    const [{ findInstructionFiles }, { loadSkills }] = await Promise.all([
      import('../context.js'),
      import('../skills/loadSkills.js'),
    ])

    const cwd = ctx.cwd
    const checks: Check[] = []

    // 步骤 2：运行环境。
    const nodeMajor = Number(process.versions.node.split('.')[0])
    checks.push({
      label: 'Node.js',
      ok: nodeMajor >= 20,
      detail: `v${process.versions.node}${nodeMajor >= 20 ? '' : ' — needs 20 or newer'}`,
    })

    const key = process.env.OPENAI_API_KEY
    checks.push({
      label: 'API key',
      ok: Boolean(key),
      // Only the prefix. A diagnostic people paste into a bug report must not
      // be the thing that leaks the credential.
      // 只显示前缀。人们会把诊断结果贴进 issue，它绝不能成为泄露密钥的那一环。
      detail: key ? `set (${key.slice(0, 6)}…)` : 'OPENAI_API_KEY is not set',
    })

    checks.push({
      label: 'Base URL',
      ok: true,
      detail: ctx.settings.baseURL ?? process.env.OPENAI_BASE_URL ?? '(openai default)',
    })

    checks.push({ label: 'Model', ok: true, detail: ctx.settings.model })

    checks.push({
      label: 'Permission mode',
      ok: ctx.settings.permissionMode !== 'bypassPermissions',
      detail:
        ctx.settings.permissionMode +
        (ctx.settings.permissionMode === 'bypassPermissions' ? ' — guard rails are off' : ''),
    })

    // Skills, hooks and MCP servers are the three places where a FILE decides
    // what the agent can do. If one of them is silently not loading, this is
    // where you find out.
    // 技能、钩子、MCP 服务器是三处「由文件决定代理能做什么」的地方。
    // 其中任何一处悄悄没加载上，就在这里发现。
    // 步骤 3：技能、钩子、MCP。
    const skills = loadSkills(cwd)
    checks.push({
      label: 'Skills',
      ok: true,
      detail:
        skills.length === 0
          ? 'none found'
          : `${skills.length}: ${skills.map(skill => skill.name).join(', ')}`,
    })

    const hookEvents = Object.entries(ctx.settings.hooks ?? {}).filter(
      ([, matchers]) => (matchers ?? []).length > 0,
    )
    checks.push({
      label: 'Hooks',
      ok: true,
      detail:
        hookEvents.length === 0
          ? 'none configured'
          : hookEvents.map(([event, matchers]) => `${event} (${matchers!.length})`).join(', '),
    })

    // Configured, not connected: the servers were dialled once at startup, and
    // re-dialling them here would spawn a second set of child processes just
    // to draw a line of text.
    // 这里看的是「配置」而非「已连接」：服务器在启动时已拨号一次，
    // 为了打印一行字再拨一次，等于凭空多起一批子进程。
    const mcpServers = Object.keys(loadMcpConfig(cwd))
    checks.push({
      label: 'MCP servers',
      ok: true,
      detail:
        mcpServers.length === 0
          ? 'none configured'
          : `${mcpServers.join(', ')} (configured; startup reports failures)`,
    })

    // 步骤 4：MINI.md 与会话记录。
    const instructionFiles = findInstructionFiles(cwd)
    checks.push({
      label: 'MINI.md',
      ok: true,
      detail:
        instructionFiles.length === 0
          ? 'none found'
          : instructionFiles.map(file => toDisplayPath(cwd, file)).join(', '),
    })

    const sessions = listSessions(cwd)
    checks.push({
      label: 'Sessions',
      ok: true,
      detail: sessions.length === 0 ? 'none saved for this project' : `${sessions.length} saved`,
    })

    // 步骤 5：探可选外部程序——两者都不是必需，故一律 ok:true，只在 detail 里说清有没有。
    const binaries: { label: string; binary: string; args: string[] }[] = [
      { label: 'git', binary: 'git', args: ['--version'] },
      { label: 'ripgrep', binary: 'rg', args: ['--version'] },
    ]
    for (const { label, binary, args } of binaries) {
      let detail: string
      try {
        detail = execFileSync(binary, args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .split('\n')[0]!
          .trim()
      } catch {
        // Neither is required; both make mini-cc better.
        // 两者都非必需，但有了会更好用。
        detail = 'not found (optional)'
      }
      checks.push({ label, ok: true, detail })
    }

    // 步骤 6：对齐并拼装报告。
    const width = Math.max(...checks.map(check => check.label.length))  // 取最长标签长度作为对齐宽度，报告各行的冒号才能排成一列
    return {
      type: 'text',
      text: [
        `${PRODUCT_NAME} v${VERSION}`,
        '',
        ...checks.map(
          check => `  ${check.ok ? '+' : '!'} ${check.label.padEnd(width)}  ${check.detail}`,
        ),
      ].join('\n'),
    }
  },
}
