# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`mini-cc` is a from-scratch reimplementation of a terminal coding agent, written as a teaching
codebase that mirrors the real Claude Code source tree file-for-file (`src/query.ts`, `src/Tool.ts`,
`src/entrypoints/cli.tsx`, `src/services/api/`, …). Source comments carry `cf. …` references to the
corresponding Claude Code module, and `Chapter N` markers for functionality deliberately stubbed
until a later chapter. **Preserve both conventions when editing** — the file layout and the comments
are part of the deliverable, not incidental.

The agent it builds reads its own project instructions from `MINI.md`, not `CLAUDE.md`, and its own
config from `.mini-cc/`, not `.claude/`. Both sets of files exist in this repo; keep them straight.

## Commands

```
npm run dev -- [flags]           # run the CLI via tsx, no build step
npm run typecheck                # tsc --noEmit — the only check that exists
npm run build                    # esbuild -> dist/mini-cc.mjs (single file)
npm start                        # run the bundle
```

There is no lint or test setup. `tsc --noEmit` is the gate — run it after every change.

Instead of unit tests there are **smoke scripts** in `tools-dev/`, each exercising one subsystem
with no model in the loop. Run one with `npx tsx tools-dev/<name>.ts`:

```
smoke.ts            file tools          smoke-search.ts       Glob / Grep
smoke-shell.ts      Bash / PowerShell   smoke-permissions.ts  the permission engine
smoke-sessions.ts   JSONL transcripts   smoke-compact.ts      context compaction
smoke-context.ts    MINI.md + context   smoke-commands.ts     slash commands
smoke-parallel.ts   tool batching       smoke-skills.ts       skill discovery
smoke-hooks.ts      lifecycle hooks     smoke-mcp.ts          MCP client (spawns the demo server)
smoke-ui.tsx        Ink components off-screen        smoke-todo.tsx   the todo panel
```

`tools-dev/testContext.ts` builds the `ToolContext` these scripts pass in.

Developing without API credits: `node tools-dev/stub-server.mjs` starts an OpenAI-compatible stub on
port 8787, then `set OPENAI_BASE_URL=http://127.0.0.1:8787/v1`. It echoes the last user message; a
message beginning with `call: ListDir {"path":"src"}` makes it emit a *fragmented* tool call instead,
which is what exercises the streaming tool-call accumulator.

Useful CLI flags: `--debug` (resolved config + diagnostics, then exit), `-m/--model`, `-c/--cwd`,
`-p/--print` (non-interactive: one prompt in, plain text out), `--permission-mode`, `--add-dir`,
`-r/--resume [id]`, `--continue`, `--list-sessions`.

## Architecture

Boot path, each stage behind a *dynamic* import so cheap commands stay cheap:
`bootstrap-entry.ts` → `entrypoints/cli.tsx` (commander dispatch; `--version` with near-zero imports)
→ `main.ts` (config resolution + mode selection) → `screens/REPL.tsx` (Ink) or `cli/print.ts`
(no TTY, or `-p`).

**`src/query.ts` is the whole program.** An async generator: it *yields* `QueryEvent`s so the UI
renders incrementally and *returns* a `Terminal` telling the caller precisely why the turn ended.
Loop: send messages + tool schemas → stream reply → no tool calls means done → otherwise run tools,
append results, repeat. Invariants:

- Turn-over is decided by the **presence of tool calls**, never by `finish_reason` — providers
  disagree about the latter.
- Every `tool_use` gets a `tool_result`, including on abort (synthesised error results), or the next
  request is malformed.
- A failing tool is not an exception at the loop level; the error text goes back to the model as a
  tool result so it can self-correct. **Recovery is a loop transition, not a throw** — context
  overflow triggers compaction and *continues*; only genuine dead ends terminate.

**Provider isolation.** Only `src/services/api/` imports `openai`. Everything above it speaks
`Message` / `ToolCall` (`src/types/message.ts`), converted at the `toApiMessages` boundary — which
also strips UI-only message kinds (`system-ui`). Keep new code on the provider-agnostic side of that
line. `stream.ts` owns the fiddly part: OpenAI streams tool calls as index-keyed fragments, so it
accumulates them and emits whole `ToolCall`s on `done`.

**Tools.** Every capability implements the single `Tool` contract in `src/Tool.ts` and receives a
`ToolContext` (cwd, AbortController, permission context, file history, app state) explicitly rather
than reaching for globals — that is what makes one permission gate sufficient, and sub-agents
possible (a sub-agent is the same loop with a derived context). Register in `src/tools.ts`;
`getAllTools(mode)` gates mode-specific tools (ExitPlanMode exists only in plan mode) and
`getSubagentTools` defines the sub-agent pool, so the *registry* decides the pool, not the tool.

**Permissions** (`src/utils/permissions.ts`, types in `src/types/permissions.ts`). One decision
ladder in front of every tool call. Rule strings are `Tool` or `Tool(pattern)` — `Bash(git push:*)`,
`Edit(src/**)`. Modes: `default`, `acceptEdits`, `plan`, `bypassPermissions`. Fail-closed is the
rule throughout: a tool that does not declare itself read-only is dangerous, a malformed rule is
dropped rather than widened, an exception during a check never enlarges what is allowed. Deny rules
apply even under `bypassPermissions`. MCP tools are never read-only, so they always reach the gate.

**Tool orchestration** (`src/services/tools/toolOrchestration.ts`). Only *consecutive*
concurrency-safe calls are batched in parallel; anything else is a batch of one. Adjacency preserves
relative order for free, with no dependency analysis. Concurrency safety is a property of the call
(`isConcurrencySafe(input)`), not of the tool.

**Hooks** (`src/utils/hooks.ts`, `src/types/hooks.ts`). The subtractive half of extensibility — MCP
injects tools, hooks intercept calls already made. Matchers take either a regex over the tool name
(`Edit|Write`) or a permission-style rule (`Bash(git push *)`), sharing `commandMatches` with the
permission engine so both behave identically.

**Context and prompts.** `constants/prompts.ts` holds the fixed system prompt; `src/context.ts`
assembles the per-session, per-machine part — `MINI.md` files walked from the home directory down to
cwd (general first, specific last, so later text wins), git status, environment. Built once per
session, not once per frame.

**Compaction** (`src/services/compact/compact.ts`). Two mechanisms, cheapest first: snip oversized
stale tool results in place (no model call), then summarise the old half of the conversation. Both
keep a verbatim tail of recent messages. Token accounting lives in `src/utils/tokens.ts`.

**Sessions** (`src/utils/sessionStorage.ts`). Append-only JSONL under
`~/.mini-cc/projects/<slug-of-cwd>/<sessionId>.jsonl`; a crash costs the last line, not the file.
`parentUuid` chains entries so rewind and compaction can prune the middle without breaking replay.
`src/utils/fileHistory.ts` is the other half of rewind — rewinding messages without restoring files
is worse than not rewinding at all.

**Extensibility layers**, each general-to-specific with the specific winning: slash commands
(`src/commands.ts`: built-ins → `~/.mini-cc/commands/*.md` → `<cwd>/.mini-cc/commands/*.md`), skills
(`src/skills/loadSkills.ts`: progressive disclosure — only name and description ship in the system
prompt, the body loads on invoke; optional globs hide a skill until a matching file is touched), and
MCP (`src/services/mcp/`: `.mcp.json`, tools namespaced `mcp__<server>__<tool>`).

**Settings** layer lowest-to-highest: defaults → `~/.mini-cc/settings.json` →
`<cwd>/.mini-cc/settings.json` → CLI flags (`src/utils/config.ts`). `.env` is read via Node 22's
`process.loadEnvFile`, no dotenv. `OPENAI_API_KEY` is required; `baseURL` / `OPENAI_BASE_URL`
retargets to Azure, Ollama, vLLM, or the stub.

## Comment convention (non-negotiable)

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
class, tool object and command object gets a one-line Chinese comment (`// 本函数：…` / `// 本类：…` /
`// 本命令：…` / `// 本常量：…`) directly above it saying what it does and what it is for.
Spec/test files (`*.spec.ts`, `*.test.ts`) are exempt.

**When writing new code or editing existing code, add these lines wherever a class or function has no
comment. Never remove or rewrite existing comments — the Chinese one-liner is added alongside them.**
