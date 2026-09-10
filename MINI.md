# MINI.md

Project instructions for mini-cc working in this repository. mini-cc loads this file
into the system prompt at startup; it is this project's equivalent of CLAUDE.md.

## What this is

`mini-cc` is a from-scratch reimplementation of a terminal coding agent, written as a
teaching codebase that mirrors the real Claude Code source tree file-for-file
(`src/query.ts`, `src/Tool.ts`, `src/entrypoints/cli.tsx`, `src/services/api/`, …).
Source comments carry `cf. …` references to the corresponding Claude Code module.
The file layout and the comments are part of the deliverable, not incidental.

## Commands

```
npm run dev -- [flags]           # run the CLI (tsx, no build step)
npm run typecheck                # tsc --noEmit — the only check that exists
node tools-dev/stub-server.mjs   # local OpenAI-compatible stub, port 8787
npx tsx tools-dev/smoke.ts       # exercise the tools with no model in the loop
npx tsx tools-dev/smoke-mcp.ts   # connect the demo MCP server, no model needed
```

There is no lint or test setup. `tsc --noEmit` is the gate — run it after every change.

Developing without API credits: start the stub server, then
`set OPENAI_BASE_URL=http://127.0.0.1:8787/v1`.

## Architecture in one paragraph

`src/bootstrap-entry.ts` → `entrypoints/cli.tsx` → `main.ts` → `screens/REPL.tsx` (Ink)
or `cli/print.ts` (no TTY, or `-p`), each stage behind a dynamic import so cheap
commands stay cheap. `src/query.ts` is the whole program: an async generator that
yields `QueryEvent`s and returns a `Terminal`. Only `src/services/api/` imports
`openai`; everything above it speaks `Message` / `ToolCall`. Every capability
implements the single `Tool` contract in `src/Tool.ts` and receives its `ToolContext`
explicitly — never through a global.

## Invariants

- Turn-over is decided by the presence of tool calls, never by `finish_reason`.
- Every `tool_use` gets a `tool_result`, including on abort.
- A failing tool is not an exception at the loop level: the error text goes back to
  the model so it can self-correct.
- A tool that does not declare itself read-only is treated as dangerous. MCP tools are
  never read-only, so they always reach the permission gate.
- Settings layer lowest-to-highest: defaults → `~/.mini-cc/settings.json` →
  `<cwd>/.mini-cc/settings.json` → CLI flags.

## Comment convention (non-negotiable)

- Every `.ts` / `.tsx` file opens with a one-line Chinese comment on line 1 saying what
  the file is and what it is for (`// 本文件：…`), after the shebang if there is one.
- Every function, class, and tool object gets a one-line Chinese comment above it
  (`// 本函数：…` / `// 本类：…` / `// 本命令：…`).
- Every English comment gets a concise Chinese translation on the line directly below
  it, inside the same comment block. Condense — convey the point, do not mirror the
  English word for word.
- Add these wherever a function or class has none. Never remove or rewrite an existing
  comment; the Chinese one-liner is added alongside it.
- Spec/test files (`*.spec.ts`, `*.test.ts`) are exempt.
