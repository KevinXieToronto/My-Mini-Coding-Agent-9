// 本文件：CLI 组装层，解析配置与环境变量并选择运行模式（诊断输出或交互式 REPL）。
import { buildPermissionContext, loadEnvFile, loadSettings } from './utils/config.js'
import { PRODUCT_NAME, VERSION } from './constants/product.js'
import { PERMISSION_MODES, type PermissionMode } from './types/permissions.js'
import { formatRule } from './utils/permissions.js'
import { listSessions, mostRecentSession, type SessionSummary } from './utils/sessionStorage.js'

export type CliOptions = {
  print?: string
  model?: string
  cwd: string
  debug: boolean
  permissionMode?: string
  addDir?: string[]
  resume?: string | boolean
  continue?: boolean
  listSessions?: boolean
}

/**
 * Real CLI assembly: resolve configuration, then choose a run mode.
 * 真正的 CLI 组装：先解析配置，再选择运行模式。
 * cf. src/main.tsx in the Claude Code tree (~800 KB there; a few lines here).
 * 参见 Claude Code 的 src/main.tsx（那边约 800 KB，这里只有几行）。
 */
// 本函数：切换工作目录、加载 .env 与分层设置；--debug 时打印诊断信息，否则启动 REPL。
export async function runCli(opts: CliOptions): Promise<void> {
  process.chdir(opts.cwd)
  loadEnvFile(opts.cwd)

  const settings = loadSettings(opts.cwd)
  if (opts.model) settings.model = opts.model  // 命令行是最高一层：分层加载完再逐项覆盖，就实现了「默认 < 用户 < 项目 < 参数」

  // Fail LOUDLY on an unknown mode. Silently falling back to `default` would
  // be safe, but a typo'd `--permission-mode plna` that quietly starts asking
  // for everything teaches the user to distrust the flag.
  // 未知模式要「大声」报错。悄悄回退到 default 虽然安全，
  // 但把 `--permission-mode plna` 这类手误静默吞掉，只会让用户不再信任这个参数。
  if (opts.permissionMode) {
    if (!(PERMISSION_MODES as string[]).includes(opts.permissionMode)) {
      throw new Error(
        `Unknown permission mode "${opts.permissionMode}". ` +
          `Valid modes: ${PERMISSION_MODES.join(', ')}`,
      )
    }
    settings.permissionMode = opts.permissionMode as PermissionMode
  }
  if (opts.addDir?.length) {
    settings.additionalDirectories = [...(settings.additionalDirectories ?? []), ...opts.addDir]
  }

  if (opts.listSessions) {
    const sessions = listSessions(process.cwd())
    if (sessions.length === 0) console.log('No saved sessions for this directory.')
    for (const session of sessions) {
      const when = new Date(session.updatedAt).toISOString().replace('T', ' ').slice(0, 16)
      console.log(`${session.sessionId}  ${when}  ${session.entryCount} msgs  ${session.preview}`)
    }
    return
  }

  const resume = resolveResume(opts)

  const permissionContext = buildPermissionContext(settings, process.cwd())

  if (opts.debug) {
    console.log(`${PRODUCT_NAME} v${VERSION}`)
    console.log(`cwd:      ${process.cwd()}`)
    console.log(`model:    ${settings.model}`)
    console.log(`baseURL:  ${settings.baseURL ?? process.env.OPENAI_BASE_URL ?? '(openai default)'}`)
    console.log(`api key:  ${process.env.OPENAI_API_KEY ? 'set' : 'MISSING'}`)
    console.log(`mode:     ${permissionContext.mode}`)
    console.log(
      `rules:    ${
        permissionContext.rules.length === 0
          ? '(none)'
          : permissionContext.rules
              .map(rule => `${rule.behavior} ${formatRule(rule)}`)
              .join(', ')
      }`,
    )
    console.log(`add-dir:  ${permissionContext.additionalDirectories.join(', ') || '(none)'}`)
    const boot = globalThis.__MINI_CC_BOOT_TIME__
    if (boot) console.log(`boot:     ${Date.now() - boot}ms`)
    return
  }

  // Ink needs a real terminal to put stdin into raw mode. If we do not have
  // one — a pipe, a CI job, `-p` — fall back to the non-interactive path
  // rather than crashing with "Raw mode is not supported".
  // Ink 需要真实终端才能把 stdin 切到 raw 模式。没有终端（管道、CI、`-p`）时
  // 走非交互路径，而不是抛「Raw mode is not supported」。
  // Connect MCP servers before the UI mounts, so their tools are in the very
  // first request rather than appearing a turn later.
  // 在 UI 挂载前连接 MCP 服务器，让其工具出现在第一次请求里，而不是晚一个回合才冒出来。
  const { connectAll, disconnectAll, renderMcpInstructions } = await import(
    './services/mcp/client.js'
  )
  const { loadMcpConfig } = await import('./services/mcp/config.js')
  const connections = await connectAll(loadMcpConfig(process.cwd()))  // 在 UI 挂载前完成连接，MCP 工具才能出现在第一次请求里
  const mcp = {
    tools: connections.flatMap(connection => connection.tools),
    instructions: renderMcpInstructions(connections),
    failures: connections
      .filter(connection => connection.error)
      .map(connection => `[mcp] ${connection.name} unavailable: ${connection.error}`),
  }

  // Print mode gets the servers too. A capability that only exists when a
  // human is watching is not a capability a script can rely on — the same
  // argument as for hooks in Ch.16.
  // print 模式同样吃这些服务器：只在有人盯着时才存在的能力，脚本无法依赖——
  // 与第 16 章为钩子所持的理由相同。
  if (opts.print !== undefined || !process.stdin.isTTY) {  // 显式 -p，或压根没有 TTY（管道、CI），都走非交互路径——Ink 无终端启动不了
    const { runPrintMode } = await import('./cli/print.js')
    try {
      await runPrintMode(settings, permissionContext, opts.print, mcp)
    } finally {
      await disconnectAll(connections)
    }
    return
  }

  const [{ render }, { createElement }, { REPL }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./screens/REPL.js'),
  ])
  const instance = render(createElement(REPL, { settings, resume, mcp }))
  await instance.waitUntilExit()  // 阻塞到 Ink 退出，下一行的断开清理才不会在界面还活着时就执行
  // A stdio server is a child process. Skip this and every session leaves an
  // orphan behind.
  // stdio 服务器是子进程。跳过这一步，每次会话都会留下孤儿进程。
  await disconnectAll(connections)
}

/**
 * --continue takes the newest session; --resume <id> takes a named one;
 * --resume with no argument also takes the newest.
 * --continue 取最新会话；--resume <id> 取指定会话；--resume 不带参数同样取最新。
 *
 * An unknown id is an ERROR, not a silent new session. Silently starting fresh
 * when someone asked to resume is how people lose an afternoon of context.
 * 未知 id 要报错，而不是悄悄新开一个会话：用户要求恢复却被静默重开，
 * 一下午的上下文就这么没了。
 */
// 本函数：根据 --continue / --resume 参数解析出要恢复的会话摘要。
function resolveResume(opts: CliOptions): SessionSummary | undefined {
  const cwd = process.cwd()
  if (opts.continue || opts.resume === true) {
    const latest = mostRecentSession(cwd)
    if (!latest) throw new Error('No saved sessions for this directory.')
    return latest
  }
  if (typeof opts.resume === 'string') {
    const found = listSessions(cwd).find(session =>  // 按前缀匹配，用户敲几位 uuid 即可；listSessions 已按时间倒序，故多个前缀相同时取最近那个
      session.sessionId.startsWith(opts.resume as string),
    )
    if (!found) throw new Error(`No session in this directory starting with "${opts.resume}".`)
    return found
  }
  return undefined
}
