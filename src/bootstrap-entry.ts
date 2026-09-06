#!/usr/bin/env node
/**
 * The outermost entry point. Keep it tiny.
 *
 * Real Claude Code does the same thing (src/bootstrap-entry.ts): install a
 * build-time macro, then hand off via a *dynamic* import. The dynamic import is
 * the point — nothing heavy is loaded until we know which mode we are in.
 */
export {}

globalThis.__MINI_CC_BOOT_TIME__ = Date.now()

await import('./entrypoints/cli.js')
