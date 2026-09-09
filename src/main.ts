// 本文件：CLI 组装层，解析配置与环境变量并选择运行模式（诊断输出或交互式 REPL）。
import { buildPermissionContext, loadEnvFile, loadSettings } from './utils/config.js'
import { PRODUCT_NAME, VERSION } from './constants/product.js'
import { PERMISSION_MODES, type PermissionMode } from './types/permissions.js'
import { formatRule } from './utils/permissions.js'

export type CliOptions = {
  print?: string
  model?: string
  cwd: string
  debug: boolean
  permissionMode?: string
  addDir?: string[]
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
  if (opts.model) settings.model = opts.model

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
  if (opts.print !== undefined || !process.stdin.isTTY) {
    const { runPrintMode } = await import('./cli/print.js')
    await runPrintMode(settings, permissionContext, opts.print)
    return
  }

  const [{ render }, { createElement }, { REPL }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./screens/REPL.js'),
  ])
  const instance = render(createElement(REPL, { settings, permissionContext }))
  await instance.waitUntilExit()
}
