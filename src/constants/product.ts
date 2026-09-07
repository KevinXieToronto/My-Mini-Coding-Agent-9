// 本文件：产品级常量（名称、版本、配置目录名、项目指令文件名），保持零依赖供各处引用。
/**
 * Product-level constants. Kept dependency-free so the `--version` fast path
 * in entrypoints/cli.tsx can import it without pulling in the world.
 * 产品级常量。保持零依赖，使 cli.tsx 中 `--version` 快路径可轻量导入。
 *
 * cf. src/constants/ in the Claude Code tree.
 * 参见 Claude Code 源码树的 src/constants/。
 */
export const PRODUCT_NAME = 'mini-cc'
export const VERSION = '0.1.0'

/**
 * Where user-level state lives: %USERPROFILE%\.mini-cc on Windows.
 * 用户级状态目录：Windows 上为 %USERPROFILE%\.mini-cc。
 */
export const CONFIG_DIR_NAME = '.mini-cc'

/**
 * Project-level instruction file, our equivalent of CLAUDE.md.
 * 项目级指令文件，相当于 CLAUDE.md。
 */
export const PROJECT_MEMORY_FILE = 'MINI.md'
