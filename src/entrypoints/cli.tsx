// 本文件：CLI 命令行调度器，声明参数并把昂贵的运行模式藏在动态 import 之后。
import { Command } from '@commander-js/extra-typings'
import { PRODUCT_NAME, VERSION } from '../constants/product.js'

/**
 * The CLI dispatcher.
 * CLI 调度器。
 *
 * cf. src/entrypoints/cli.tsx in the Claude Code tree, which dispatches about a
 * dozen run modes before the main CLI is ever imported. `--version` there
 * answers with zero imports beyond that one file. We keep the same shape: the
 * expensive REPL is behind a dynamic import so cheap commands stay cheap.
 * 参见 Claude Code 的 src/entrypoints/cli.tsx：在导入主 CLI 前先分发十余种运行模式，
 * `--version` 只需该文件本身。此处保持同样结构：昂贵的 REPL 藏在动态 import 之后，
 * 让廉价命令保持廉价。
 */
// 本函数：构建命令行程序、解析参数，再动态载入主流程执行。
async function main(): Promise<void> {
  const program = new Command()
    .name(PRODUCT_NAME)
    .description('A mini terminal coding agent')
    .version(VERSION, '-v, --version')
    .option('-p, --print <prompt>', 'run one prompt non-interactively and exit')
    .option('-m, --model <model>', 'model id to use')
    .option('-c, --cwd <dir>', 'working directory', process.cwd())
    .option('--debug', 'print diagnostic output', false)
    .option(
      '--permission-mode <mode>',
      'default | acceptEdits | plan | bypassPermissions',
    )
    .option(
      '--add-dir <dir...>',
      'additional directories the agent may write to',
    )
    .option('-r, --resume [sessionId]', 'resume a previous session in this directory')
    .option('--continue', 'resume the most recent session in this directory', false)
    .option('--list-sessions', 'list saved sessions and exit', false)

  program.parse(process.argv)
  const opts = program.opts()

  // Dynamic import: the REPL and the model client are only loaded when needed.
  // 动态 import：REPL 与模型客户端按需加载。
  const { runCli } = await import('../main.js')
  await runCli(opts)
}

main().catch((error: unknown) => {
  console.error(`${PRODUCT_NAME}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
