import { loadEnvFile, loadSettings } from './utils/config.js'
import { PRODUCT_NAME, VERSION } from './constants/product.js'

export type CliOptions = {
  print?: string
  model?: string
  cwd: string
  debug: boolean
}

/**
 * Real CLI assembly: resolve configuration, then choose a run mode.
 * cf. src/main.tsx in the Claude Code tree (~800 KB there; a few lines here).
 */
export async function runCli(opts: CliOptions): Promise<void> {
  process.chdir(opts.cwd)
  loadEnvFile(opts.cwd)

  const settings = loadSettings(opts.cwd)
  if (opts.model) settings.model = opts.model

  if (opts.debug) {
    console.log(`${PRODUCT_NAME} v${VERSION}`)
    console.log(`cwd:      ${process.cwd()}`)
    console.log(`model:    ${settings.model}`)
    console.log(`baseURL:  ${settings.baseURL ?? process.env.OPENAI_BASE_URL ?? '(openai default)'}`)
    console.log(`api key:  ${process.env.OPENAI_API_KEY ? 'set' : 'MISSING'}`)
    const boot = globalThis.__MINI_CC_BOOT_TIME__
    if (boot) console.log(`boot:     ${Date.now() - boot}ms`)
    return
  }

  const { runReadlineREPL } = await import('./screens/ReadlineREPL.js')
  await runReadlineREPL(settings)
}
