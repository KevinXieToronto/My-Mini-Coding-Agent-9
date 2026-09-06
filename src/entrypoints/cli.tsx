import { Command } from '@commander-js/extra-typings'
import { PRODUCT_NAME, VERSION } from '../constants/product.js'

/**
 * The CLI dispatcher.
 *
 * cf. src/entrypoints/cli.tsx in the Claude Code tree, which dispatches about a
 * dozen run modes before the main CLI is ever imported. `--version` there
 * answers with zero imports beyond that one file. We keep the same shape: the
 * expensive REPL is behind a dynamic import so cheap commands stay cheap.
 */
async function main(): Promise<void> {
  const program = new Command()
    .name(PRODUCT_NAME)
    .description('A mini terminal coding agent')
    .version(VERSION, '-v, --version')
    .option('-p, --print <prompt>', 'run one prompt non-interactively and exit')
    .option('-m, --model <model>', 'model id to use')
    .option('-c, --cwd <dir>', 'working directory', process.cwd())
    .option('--debug', 'print diagnostic output', false)

  program.parse(process.argv)
  const opts = program.opts()

  // Dynamic import: the REPL and the model client are only loaded when needed.
  const { runCli } = await import('../main.js')
  await runCli(opts)
}

main().catch((error: unknown) => {
  console.error(`${PRODUCT_NAME}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
