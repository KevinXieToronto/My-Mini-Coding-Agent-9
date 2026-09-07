# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`mini-cc` is a from-scratch reimplementation of a terminal coding agent, written as a teaching
codebase that mirrors the real Claude Code source tree file-for-file (`src/query.ts`, `src/Tool.ts`,
`src/entrypoints/cli.tsx`, `src/services/api/`, …). Source comments carry `cf. …` references to the
corresponding Claude Code module and `Chapter N` markers for functionality that is deliberately
stubbed until a later chapter. **Preserve both conventions when editing** — the file layout and the
comments are part of the deliverable, not incidental.

Current state: Chapter 4 (agent loop + streaming + the zod-backed `Tool` contract with
Read / Write / Edit / ListDir).

## Commands

```
npm run dev -- [flags]     # run the CLI (tsx, no build step)
npm run typecheck          # tsc --noEmit — the only check that exists
node tools-dev/stub-server.mjs   # local OpenAI-compatible stub, port 8787
npx tsx tools-dev/smoke.ts       # exercise the tools with no model in the loop
npx tsx tools-dev/smoke-ui.tsx   # render the Ink components off-screen, no model needed
```

There is no build, lint, or test setup. `tsc --noEmit` is the gate.

Useful CLI flags: `--debug` (print resolved config and exit), `-m/--model`, `-c/--cwd`,
`-p/--print` (non-interactive: one prompt in, plain text out).

Developing without API credits — start the stub server, then:
`set OPENAI_BASE_URL=http://127.0.0.1:8787/v1`. It echoes the last user message; a message
beginning with `call: ListDir {"path":"src"}` makes it emit a fragmented tool call instead, which
exercises the streaming tool-call accumulator.

## Architecture

Boot path, each stage behind a *dynamic* import so cheap commands stay cheap:
`bootstrap-entry.ts` → `entrypoints/cli.tsx` (commander dispatch, `--version` with near-zero
imports) → `main.ts` (config resolution + mode selection) → `screens/REPL.tsx` (Ink) or
`cli/print.ts` (no TTY, or `-p`).

**`src/query.ts` is the whole program.** It is an async generator: it *yields* `QueryEvent`s so the
UI renders incrementally and *returns* a `Terminal` telling the caller precisely why the turn ended.
Loop: send messages + tool schemas → stream reply → no tool calls means done → otherwise run tools,
append results, repeat. Two invariants to keep:

- Turn-over is decided by the **presence of tool calls**, never by `finish_reason` — providers
  disagree about the latter.
- Every `tool_use` must get a `tool_result`, including on abort (synthesised error results), or the
  next request is malformed.
- A failing tool is not an exception at the loop level; the error text goes back to the model as a
  tool result so it can self-correct. Recovery is a loop transition, not a throw.

**Provider isolation.** Only `src/services/api/` imports `openai`. Everything above it speaks
`Message` / `ToolCall` (`src/types/message.ts`), converted at the `toApiMessages` boundary — which
also strips UI-only message kinds (`system-ui`). Keep new code on the provider-agnostic side of that
line. `stream.ts` owns the fiddly part: OpenAI streams tool calls as index-keyed fragments, so it
accumulates them and emits whole `ToolCall`s on `done`.

**Tools.** Every capability implements the single `Tool` contract in `src/Tool.ts` and receives a
`ToolContext` (cwd, AbortController) explicitly rather than reaching for globals — that is what makes
one permission gate sufficient later, and sub-agents possible (a sub-agent is the same loop with a
different context). Register in `src/tools.ts`.

**Settings** layer lowest-to-highest: defaults → `~/.mini-cc/settings.json` → `<cwd>/.mini-cc/settings.json`
→ CLI flags (`src/utils/config.ts`). `.env` is read via Node 22's `process.loadEnvFile`, no dotenv.
`OPENAI_API_KEY` is required; `baseURL` / `OPENAI_BASE_URL` retargets to Azure, Ollama, vLLM, or the stub.

Project-level instruction file for the agent being built is `MINI.md`, not `CLAUDE.md`.

## Comment convention

Every English comment gets a **concise** Chinese translation on the line directly below it, inside
the same comment block. Condense — convey the point, do not mirror the English word for word.
Applies to line comments and to JSDoc/block comments alike.

```ts
// Turn-over is decided by the presence of tool calls, not finish_reason.
// 回合结束看是否有工具调用，不看 finish_reason。
if (toolCalls.length === 0) {
```

```ts
/**
 * The capability contract. Every capability implements this one interface.
 * 能力契约：所有能力均实现此接口。
 */
```

### Chinese header comments

Every `.ts` / `.tsx` file opens with a one-line Chinese comment saying what the file is and what it
is used for (`// 本文件：…`), placed on line 1 — after the shebang, if there is one. Every function,
class, and tool object gets a one-line Chinese comment (`// 本函数：…` / `// 本类：…`) directly above
it saying what it does and what it is for. Spec/test files (`*.spec.ts`, `*.test.ts`) are exempt.

**When writing new code or editing existing code, add these lines wherever a class or function has no
comment. Never remove or rewrite existing comments — the Chinese one-liner is added alongside them.**
