/**
 * Product-level constants. Kept dependency-free so the `--version` fast path
 * in entrypoints/cli.tsx can import it without pulling in the world.
 *
 * cf. src/constants/ in the Claude Code tree.
 */
export const PRODUCT_NAME = 'mini-cc'
export const VERSION = '0.1.0'

/** Where user-level state lives: %USERPROFILE%\.mini-cc on Windows. */
export const CONFIG_DIR_NAME = '.mini-cc'

/** Project-level instruction file, our equivalent of CLAUDE.md. */
export const PROJECT_MEMORY_FILE = 'MINI.md'
