#!/usr/bin/env node
// 本文件：CLI 最外层入口，记录启动时间后动态载入命令行入口。
/**
 * The outermost entry point. Keep it tiny.
 * 最外层入口，保持极小。
 *
 * Real Claude Code does the same thing (src/bootstrap-entry.ts): install a
 * build-time macro, then hand off via a *dynamic* import. The dynamic import is
 * the point — nothing heavy is loaded until we know which mode we are in.
 * 真实 Claude Code 同样如此：装载构建期宏后用动态 import 转交。
 * 动态 import 是关键——在确定运行模式前不加载任何重量级模块。
 */
export {}

globalThis.__MINI_CC_BOOT_TIME__ = Date.now()

await import('./entrypoints/cli.js')
