# Testing mini-cc — how to verify any code change

本文件：mini-cc 的测试手册。任何代码改动都按这里的四道关卡验证：类型检查 → 冒烟脚本 → 交互提示词 → 构建。

There is no unit-test framework in this repo, by design. What exists instead is a four-gate
ladder, cheapest first. Run the gates in order; stop at the first one that fails, because a
later gate cannot tell you anything a failing earlier gate has not already invalidated.

| Gate | What it is | Model needed? | Runtime |
|---|---|---|---|
| **0. Typecheck** | `npm run typecheck` | no | ~10 s |
| **1. Smoke scripts** | 14 scripts in `tools-dev/`, one per subsystem, no model in the loop | no | ~60 s total |
| **2. Prompt tests** | Type a prompt into the running agent, compare against an expected behaviour | stub or live | minutes |
| **3. Build** | `npm run build` + run the bundle | no | ~5 s |

> **Gate 1 is the one that actually catches regressions.** Gate 2 is non-deterministic — a model
> may reach the same correct end state by a different route — so its "expected result" is written
> as *behaviour to observe*, not as text to diff.
> 第 1 关才是真正抓回归的一关；第 2 关不确定，判据写的是「该看到什么行为」，不是逐字比对。

---

## 0. Setup

### 0.1 Prerequisites

```
node --version      # must print v20+ (v22 verified)
npm install
```

### 0.2 Two ways to get a model

Every prompt test below is tagged **[STUB]** or **[LIVE]**.

**[STUB] — no API credits needed.** `tools-dev/stub-server.mjs` is an OpenAI-compatible server
that echoes the last user message. One magic input makes it emit a *fragmented* tool call, which
is what exercises the streaming accumulator in `src/services/api/stream.ts`.

```
:: terminal 1
node tools-dev/stub-server.mjs

:: terminal 2
set OPENAI_BASE_URL=http://127.0.0.1:8787/v1
set OPENAI_API_KEY=stub
npm run dev
```

The stub answers any prompt with `You said: <your text>`. The prompt
`call: ListDir {"path":"src"}` makes it emit a tool call instead of prose.

**[LIVE] — needs a real key.** Anything that requires the model to *decide* something (pick a
tool, obey MINI.md, write a plan, invoke a skill) cannot be tested against the stub.

```
set OPENAI_API_KEY=sk-...
npm run dev
```

Confirm which one you are on before blaming a failure on your change:

```
npm run dev -- --debug
```

Verified output on this tree with no key set:

```
mini-cc v0.1.0
cwd:      C:\Backup\Agent\coding-agent\My-Mini-Coding-Agent-9-claude
model:    gpt-5
baseURL:  (openai default)
api key:  MISSING
mode:     default
rules:    deny Bash(rm *), deny Edit(.env), allow Bash(npx tsc --noEmit)
add-dir:  (none)
boot:     142ms
```

`api key: MISSING` means every **[LIVE]** case below will fail for a reason that has nothing to
do with your change.

### 0.3 Expect one warning, always

`.mcp.json` deliberately configures a server named `broken`. This line is **correct output**, not
a failure:

```
[mcp] broken unavailable: MCP error -32000: Connection closed
```

它是故意配置的坏服务器，用来验证「一个 MCP 服务器挂掉不会拖垮整个启动流程」。

---

## Gate 0 — Typecheck

`tsc --noEmit` is the only static check that exists. Run it after **every** change, including
comment-only changes (the Chinese-comment convention can break a block comment).

```
npm run typecheck
```

Expected: no output, exit code 0.
预期：无输出，退出码 0。

---

## Gate 1 — Smoke scripts

Each script exercises one subsystem with no model in the loop. They **print** rather than
assert, so a regression shows up as *changed output*. See §"Golden baselines" below for how to
make that diffable.

Run them all:

```
for %s in (smoke smoke-search smoke-shell smoke-permissions smoke-sessions smoke-compact smoke-context smoke-commands smoke-parallel smoke-skills smoke-hooks smoke-mcp) do npx tsx tools-dev/%s.ts
npx tsx tools-dev/smoke-ui.tsx
npx tsx tools-dev/smoke-todo.tsx
```

---

### S-1 · `smoke.ts` — file tools

**Covers** `src/Tool.ts`, `src/tools/FileReadTool.ts`, `FileWriteTool.ts`, `FileEditTool.ts`,
`ListDirTool.ts`, `src/tools.ts`
**覆盖**：Tool 契约与四个文件工具——含 read-before-edit、唯一性、陈旧检测三条安全规则。

```
npx tsx tools-dev/smoke.ts
```

Key expected lines (verified):

```
--- 4. Non-unique old_string must be blocked ---
Edit: BLOCKED — old_string appears 2 times in dup.txt. Add more surrounding context to make it unique, or pass replace_all: true.

--- 6. Unknown key rejected by strictObject ---
Read: SCHEMA ERROR Unrecognized key(s) in object: 'bogus'

--- 8. Overwrite an unread existing file is blocked ---
Write: BLOCKED — other.txt already exists and has not been read in this session.

--- 9. Stale edit is blocked ---
Edit: BLOCKED — hello.txt has been modified since you read it.
```

**If a BLOCKED line becomes OK**, a safety invariant is gone — that is the single most important
failure this file catches. `readFileState` on the `ToolContext` is what makes cases 8 and 9 work;
if you touched `ToolContext` plumbing, suspect that first.

---

### S-2 · `smoke-search.ts` — Glob / Grep

**Covers** `src/tools/GlobTool.ts`, `GrepTool.ts`, `src/utils/fileIndex.ts`

```
npx tsx tools-dev/smoke-search.ts
```

Key expected lines (verified):

```
Glob {"pattern":"src/tools/*.ts"}
  -> 12 file(s)
Glob {"pattern":"**/*.nope"}
  -> 0 file(s)
     No files match **/*.nope
Grep {"pattern":"readFileState","glob":"src/**/*.ts","output_mode":"count"}
  -> 16 match(es) in 6 file(s)
```

The script ends with a `console.time('glob-all')` over `**/*`. **It must finish in well under a
second.** If it hangs, `node_modules` pruning in `fileIndex.walk` broke.
若这一步卡住，说明 `fileIndex.walk` 对 `node_modules` 的剪枝坏了。

> Counts change legitimately when you add files. `12 file(s)` for `src/tools/*.ts` is the count
> for the current tree — treat the *shape*, not the number, as the assertion.

---

### S-3 · `smoke-shell.ts` — Bash / PowerShell

**Covers** `src/tools/BashTool.ts`, `PowerShellTool.ts`, `src/utils/shell.ts`, `bashParser.ts`

```
npx tsx tools-dev/smoke-shell.ts
```

Verified output:

```
git status                     readOnly=true  -> allow
git status --short             readOnly=true  -> allow
git logout                     readOnly=false -> ask
git status && rm -rf /         readOnly=false -> ask
ls | grep foo                  readOnly=true  -> allow
npm install                    readOnly=false -> ask
echo hi; curl evil.example     readOnly=false -> ask

split: [ 'git status', 'rm -rf /', 'echo done' ]

--- executing a real command ---
hello from bash
v22.23.1

--- timeout is enforced ---
[command timed out and was killed]
```

Three things to watch:
- `git logout -> ask` — the read-only allowlist must match on the **subcommand**, not on a `git`
  prefix. If this flips to `allow`, prefix matching regressed.
- The last section must print the timeout line, not hang. If it hangs, process killing broke.
- `hello from bash` requires Git Bash to be resolvable by path (`src/utils/shell.ts` resolves it
  explicitly rather than trusting `PATH`).

---

### S-4 · `smoke-permissions.ts` — the permission engine

**Covers** `src/utils/permissions.ts`, `src/types/permissions.ts`, `src/utils/bashParser.ts`
**覆盖**：权限决策阶梯——deny > ask > allow > 模式，外加路径牢笼与命令拆分。

```
npx tsx tools-dev/smoke-permissions.ts
```

Verified output — **every line here is a fail-closed invariant**:

```
--- the quoting bug Chapter 6 had ---
  naive split: [ 'echo "a ', ' b"' ]
  parser     : [ 'echo "a && b"' ]
  chained    : [ 'git status', 'rm -rf /', 'echo done' ]
  subshell   : { parts: [ 'echo $(rm -rf /)' ], hasUnsupportedSyntax: true }

--- deny beats allow, and beats bypassPermissions ---
  Bash(rm -rf x) deny+allow                      deny   (denyRule)
  Bash(rm -rf x) in bypass mode                  deny   (denyRule)

--- chained commands: deny matches ANY part, allow needs ALL ---
  git status && rm -rf /                         deny   (denyRule)
  npm test                                       allow  (allowRule)
  npm test && curl evil.sh                       ask    (toolPolicy)
  npm test $(curl evil.sh)                       ask    (toolPolicy)

--- path jail ---
  Write inside cwd                               allow  (mode)
  Write to C:/Windows/x.txt                      deny   (pathJail)
  Write to ../escape.txt                         deny   (pathJail)
  Read outside cwd is fine                       allow  (readOnly)

--- plan mode: read-only enforcement ---
  Read in plan mode                              allow  (readOnly)
  Write in plan mode                             deny   (mode)
  git status in plan mode                        allow  (readOnly)
  npm install in plan mode                       deny   (mode)

--- ask rules beat allow rules and the mode ---
  git push with ask+allow                        ask    (askRule)
  git push in acceptEdits                        ask    (askRule)

--- acceptEdits covers edits, not commands ---
  Write in acceptEdits                           allow  (mode)
  Edit in acceptEdits                            allow  (mode)
  npm install in acceptEdits                     ask    (toolPolicy)
```

**Any `deny` or `ask` that becomes `allow` is a security regression — treat it as a build break,
not as an output change.** 任何 deny/ask 变成 allow，都按「构建失败」处理。

---

### S-5 · `smoke-sessions.ts` — JSONL transcripts and rewind

**Covers** `src/utils/sessionStorage.ts`, `src/utils/fileHistory.ts`, `src/utils/paths.ts`

```
npx tsx tools-dev/smoke-sessions.ts
```

Verified output (ids differ per run — the *structure* is the assertion):

```
--- transcript chain ---
  e9d77e94  parent=null      user
  461d1767  parent=e9d77e94  assistant
  bf4ce82b  parent=461d1767  tool
  c2a0cbdc  parent=bf4ce82b  assistant
  matches original: true

--- torn last line ---
  entries after corruption: 4

--- rewind restores files ---
  on disk now      : "edited twice\n"
  after rewind to 4: "edited once\n"
  after rewind to 2: "original\n"
```

Three assertions in one:
1. `parentUuid` chains correctly and round-trips (`matches original: true`).
2. A truncated final line costs **one entry, not the file** — `entries after corruption: 4`,
   never `0` and never a thrown error.
3. Rewind restores **file contents**, not just messages. Rewinding messages while leaving files
   edited is worse than not rewinding at all.

---

### S-6 · `smoke-compact.ts` — compaction and token accounting

**Covers** `src/services/compact/compact.ts`, `src/utils/tokens.ts`

```
npx tsx tools-dev/smoke-compact.ts
```

Verified output (abridged):

```
--- context windows ---
  gpt-4.1-mini         window=1,000,000  compact at 987,000
  gpt-4o               window=  128,000  compact at 115,000
  gpt-4                window=    8,192  compact at 4,000
  qwen2.5-coder:14b    window=   32,768  compact at 19,768
  something-unknown    window=   32,768  compact at 19,768

--- snip only (no model call) ---
  tokens  : ~3680
  last tool result untouched: true

--- full compaction ---
  method  : snip
  tokens  : ~13560 -> ~3680
  no orphan tool message at the head: true

--- summary path: long prose, so snipping cannot help ---
  head    : ~8577 tokens -> ~5354 sent (budget 5422, window 8192)
  request fits the window: true

--- cost tracker ---
  gpt-4.1-mini: $0.1192
  unknown model: undefined
```

The load-bearing lines:
- `something-unknown` must fall back to a window, never `NaN` or `undefined`.
- `last tool result untouched: true` — snipping must spare the recent tail, or the model loses
  the result it is mid-way through reasoning about.
- `no orphan tool message at the head: true` — a `tool` message whose `tool_use` was pruned makes
  the **next API request malformed**. This is the highest-value line in the file.
- `request fits the window: true` — the summarisation request must itself be bounded by the
  window, or compaction fails exactly when it is needed most.

---

### S-7 · `smoke-context.ts` — MINI.md, @mentions, system prompt

**Covers** `src/context.ts`, `src/constants/prompts.ts`

```
npx tsx tools-dev/smoke-context.ts
```

Verified output (abridged):

```
--- instruction files found (general -> specific) ---
  ...\MINI.md
  ...\demo\MINI.md
  ...\demo\sub\MINI.md
...
--- prompt size: 5478 chars ---
```

Assertions:
- Order is **general first, specific last** — later text wins. A reversed list silently inverts
  every project rule.
- The `@shared-rules.md` import inside `demo/MINI.md` is **inlined** in the merged output.
- `expandUserMentions('what does @demo/shared-rules.md say?')` inlines the file into what the
  user typed.
- Prompt size stays in the ~5 KB range. A sudden jump to tens of KB means something that belongs
  in progressive disclosure (skill bodies, tool docs) leaked into the fixed prompt.

---

### S-8 · `smoke-commands.ts` — slash command registry

**Covers** `src/commands.ts`, `src/commands/builtins.ts`, `src/types/command.ts`

```
npx tsx tools-dev/smoke-commands.ts
```

Verified output:

```
--- parsing a command line ---
  /help                  { name: 'help', args: '' }
  /review src/app.ts     { name: 'review', args: 'src/app.ts' }
  /mode plan             { name: 'mode', args: 'plan' }
  not a command          undefined

--- argument substitution ---
  Review a.ts and b.ts, all args: a.ts b.ts
  Missing: $3

--- frontmatter ---
  { frontmatter: { description: 'hi' }, body: 'body text' }

--- a project command file ---
  registry: clear, compact, context, doctor, exit, explain, help, mode, model, review, sessions, test
  source: project | hint: <path>

--- aliases ---
  /? -> help
  /quit -> exit
  /nope -> undefined
```

- `explain` and `test` come from `.mini-cc/commands/*.md` — they prove the **file-defined**
  layer loads, not just built-ins.
- `Missing: $3` — an unsupplied positional must survive as literal text, not crash.
- `/cost` and `/rewind` are **absent from this list on purpose**: they are registered only when
  the session state they need exists. Their absence here is not a bug.
  `/cost` 与 `/rewind` 依赖会话状态，按设计不在这份静态清单里。

---

### S-9 · `smoke-parallel.ts` — tool batching and sub-agents

**Covers** `src/services/tools/toolOrchestration.ts`, `src/tools/AgentTool.ts`

```
npx tsx tools-dev/smoke-parallel.ts
```

Verified output:

```
  read, read, edit, read  (the ordering case)
    PARALLEL  Read, Read
    serial    Edit
    PARALLEL  Read

  bash: read-only vs mutating
    PARALLEL  Bash, Bash
    serial    Bash
    PARALLEL  Bash

  malformed arguments fail closed
    serial    Read
    PARALLEL  Read

--- concurrency limit and order preservation ---
  completion order: 2, 1, 0, 5, 3, 4, 7, 6
  results in order: 0, 1, 2, 3, 4, 5, 6, 7

--- sub-agent context isolation ---
  own readFileState  : 0 (parent has 1)
  own AbortController: true
  shares permissions : true
  shares fileHistory : true
  child grant leaks? : false

--- aborting the parent aborts the child ---
  before: false
  after : true
```

The four invariants, in order of how badly they break things:
1. `child grant leaks? : false` — a one-off approval inside a sub-agent must not become a
   standing grant for the parent. This is a **privilege-escalation** check.
2. `results in order` must be sorted even though `completion order` is not.
3. Only **consecutive** safe calls batch — the `Edit` in the middle splits the batch.
4. Malformed input falls back to `serial`, never to parallel.

---

### S-10 · `smoke-skills.ts` — progressive disclosure

**Covers** `src/skills/loadSkills.ts`, `src/tools/SkillTool.ts`

```
npx tsx tools-dev/smoke-skills.ts
```

Verified output:

```
--- loading ---
  commit-message   project  body=483 chars
  python-style     project  body=77 chars  conditional on **/*.py

--- conditional visibility ---
  nothing touched  : commit-message
  touched app.py   : commit-message, python-style

--- progressive disclosure: what the prompt actually costs ---
  prompt section: ~75 tokens
  all bodies    : ~141 tokens  (NOT in the prompt)

--- invoking a skill ---
  unknown name: { ok: false, message: 'No skill named "nonexistent". Available: commit-message, python-style' }
  loaded: loaded (~121 tokens)
```

The whole point is the last block: **bodies must not be in the prompt**. If `prompt section`
starts growing with the bodies, progressive disclosure is gone.
关键在最后一段：技能正文绝不能进系统提示词。

---

### S-11 · `smoke-hooks.ts` — lifecycle hooks

**Covers** `src/utils/hooks.ts`, `src/types/hooks.ts`, `.mini-cc/hooks/*.mjs`

```
npx tsx tools-dev/smoke-hooks.ts
```

Verified output:

```
loaded events: [ 'PreToolUse', 'PostToolUse' ]
regex matcher  Edit  -> true
regex matcher  Read  -> false
rule  Bash(git push *) / git push --force -> true
rule  Bash(git push *) / git status       -> false
PreToolUse .env  -> { decision: 'deny', reason: 'Secrets live in .env; ask a human to change it.' }
PreToolUse src   -> {}
PostToolUse      -> { additionalContext: '[note] PostToolUse saw Edit' }
```

Both matcher styles must work — a regex over the tool name, and a permission-style rule. They
share `commandMatches` with the permission engine, so a change to `bashParser.ts` shows up here
too. If S-4 and S-11 fail together, fix the parser, not the hooks.

---

### S-12 · `smoke-mcp.ts` — MCP client

**Covers** `src/services/mcp/client.ts`, `src/services/mcp/config.ts`

```
npx tsx tools-dev/smoke-mcp.ts
```

Verified output (dice roll varies):

```
configured servers: [ 'demo', 'broken' ]
- demo: 3 tools
- broken: FAILED (MCP error -32000: Connection closed)
namespaced names: [ 'mcp__demo__roll_dice', 'mcp__demo__word_count', 'mcp__demo__always_fails' ]
read-only? false
renderCall: demo:roll_dice({"sides":6,"count":2})
result: Rolled 2d6: 1, 4 (total 5) | data: { server: 'demo' }
always_fails threw: this tool is broken on purpose
```

Assertions:
- A failing server **degrades**, it does not abort startup (`broken: FAILED`, `demo: 3 tools`).
- Names are namespaced `mcp__<server>__<tool>` — no collisions with built-ins.
- `read-only? false` — **MCP tools are never read-only**, so they always reach the permission
  gate. If this ever prints `true`, third-party code just bypassed permissions.
- `always_fails threw` — a throwing MCP tool becomes a tool result, not a crashed turn.

---

### S-13 · `smoke-ui.tsx` — Ink components off-screen

**Covers** `src/components/ToolCard.tsx`, `src/components/Markdown.tsx`

```
npx tsx tools-dev/smoke-ui.tsx
```

Verified output:

```
● Read(src/query.ts)

● Grep(buildTool)
  ⎿  15 matches in 8 files

● Bash(npm install)
  ⎿  user declined

● Edit(src/app.ts)
  - const b = 2
  + const b = 3
  + const c = 4
Heading

Some bold and code.

  • one
  • two
```

Renders through `ink-testing-library`, so it needs no TTY and works in CI.

---

### S-14 · `smoke-todo.tsx` — todos, plan mode, tool gating

**Covers** `src/tools/TodoWriteTool.ts`, `src/types/todo.ts`, `src/components/TodoPanel.tsx`,
`src/tools/ExitPlanModeTool.ts`, `src/state/appState.ts`

```
npx tsx tools-dev/smoke-todo.tsx
```

Verified output:

```
--- two in_progress is rejected ---
  { ok: false, message: '2 tasks are marked in_progress. Exactly one task may be in progress at a time — ...' }
  model sees: "Todo list updated (1/3 complete). Now: Adding a health check route."

╭─────────────────────────────────────────╮
│ Tasks 1/3                               │
│ ☑ Read the server module                │
│ ▶ Adding a health check route           │
│ ☐ Write a test for it                   │
╰─────────────────────────────────────────╯

--- ExitPlanMode is only advertised in plan mode ---
  default: Read, Write, Edit, Glob, Grep, Bash, PowerShell, ListDir, TodoWrite
  plan   : Read, Write, Edit, Glob, Grep, Bash, PowerShell, ListDir, TodoWrite, ExitPlanMode

--- plan mode blocks writes but lets ExitPlanMode through ---
  Read           allow  (readOnly)
  Edit           deny   (mode)
  Bash           deny   (mode)
  TodoWrite      allow  (readOnly)
  ExitPlanMode   ask    (toolPolicy)

--- approving the plan flips the mode ---
  before: plan
  after : acceptEdits
```

`getAllTools(mode)` deciding the pool — **the registry gates, not the tool** — is the line the
`default:` / `plan:` pair is checking.

---

## Gate 2 — Prompt tests

Type these into `npm run dev`. Each case says which endpoint it needs.
每条用例都标了所需端点：**[STUB]** 不用额度，**[LIVE]** 需要真实 key。

Because a model may take a different-but-correct route, judge these by **behaviour observed**,
not by exact text.

### P-1 · Streaming and the plain reply path — **[STUB]**

| | |
|---|---|
| **Prompt** | `hello there` |
| **Expect** | `You said: hello there`, rendered incrementally, then the prompt returns. No tool card. |
| **Breaks if** | text arrives all at once (streaming lost), or the turn never ends |

Non-interactive equivalent, verified:

```
npx tsx src/bootstrap-entry.ts -p "hello there"
```
```
You said: hello there
```

### P-2 · Fragmented tool-call accumulation — **[STUB]**

| | |
|---|---|
| **Prompt** | `call: ListDir {"path":"src"}` |
| **Expect** | a `ListDir(src)` tool card, a permission prompt (in `default` mode), then a second turn |
| **Breaks if** | the tool name or arguments arrive garbled — the stub emits the call **in fragments** on purpose, so this is the accumulator test in `services/api/stream.ts` |

Verified, bypassing the gate to keep it non-interactive:

```
npx tsx src/bootstrap-entry.ts -p "call: ListDir {\"path\":\"src\"}" --permission-mode bypassPermissions
```
```
You said: done: src
```

### P-3 · The agent loop end-to-end — **[LIVE]**

| | |
|---|---|
| **Prompt** | `read package.json and tell me what the build script does` |
| **Expect** | a `Read(package.json)` card, then prose citing `node scripts/build.mjs`. Exactly one tool call, then the turn ends. |
| **Breaks if** | the loop keeps calling tools after the model stopped asking for them — turn-over must be decided by *presence of tool calls*, never `finish_reason` |

### P-4 · A failing tool is not a crash — **[LIVE]**

| | |
|---|---|
| **Prompt** | `read the file src/does-not-exist.ts` |
| **Expect** | a tool card showing the error, then the model *recovers* — says the file is missing, possibly greps for the real name. The session stays alive. |
| **Breaks if** | the CLI exits or prints a stack trace. A failing tool is a tool result, not an exception. |

### P-5 · Ctrl+C mid-turn — **[LIVE]**

| | |
|---|---|
| **Prompt** | `list every file under src and summarise each one`, then press **Ctrl+C** while tools are running |
| **Expect** | the turn stops, the prompt returns, and the **next** message works normally |
| **Breaks if** | the next request errors — every `tool_use` must still get a synthesised `tool_result` on abort, or the follow-up request is malformed |

### P-6 · Permission gate, ask path — **[LIVE]**

| | |
|---|---|
| **Prompt** | `run npm install` |
| **Expect** | permission modal. `n` → the model is told it was declined and adapts. `y` → runs once. `a` → runs, and a second `npm install` this session does **not** re-prompt. |
| **Breaks if** | it runs without asking |

### P-7 · Permission gate, deny rule — **[LIVE]**

| | |
|---|---|
| **Prompt** | `delete notes.txt using rm` |
| **Expect** | denied outright, **no modal** — `.mini-cc/settings.json` carries `deny: Bash(rm *)`. The model is told and should suggest an alternative. |
| **Also try** | `/mode bypassPermissions` first, then repeat. **It must still be denied.** |
| **Breaks if** | bypass mode overrides a deny rule |

### P-8 · Path jail — **[LIVE]**

| | |
|---|---|
| **Prompt** | `write "test" to C:/Windows/minicc-test.txt` |
| **Expect** | denied with a path-jail reason, in **every** mode including `bypassPermissions` |

### P-9 · Hook blocks a write — **[LIVE]**

| | |
|---|---|
| **Prompt** | `create a .env file with API_KEY=123` |
| **Expect** | blocked with `Secrets live in .env; ask a human to change it.` — that string comes from `.mini-cc/hooks/guard-env.mjs`, i.e. the hook fired, not the permission engine |
| **Breaks if** | the file is created, or the block cites a deny rule instead of the hook |

### P-10 · Hook adds context — **[LIVE]**

| | |
|---|---|
| **Prompt** | `create a file scratch.txt containing hello` |
| **Expect** | the write succeeds and `[note] PostToolUse saw Write` reaches the model (ask it what note it just saw) |

### P-11 · MINI.md is obeyed — **[LIVE]**

| | |
|---|---|
| **Prompt** | `add a helper function to a new file src/utils/demo.ts` |
| **Expect** | the new file opens with a `// 本文件：…` line and the function carries `// 本函数：…` — the comment convention lives in `MINI.md`, so this tests context assembly, not the model's taste |
| **Breaks if** | the file has no Chinese header — `MINI.md` did not reach the system prompt |

### P-12 · @mention expansion — **[LIVE]**

| | |
|---|---|
| **Prompt** | `what does @demo/shared-rules.md say?` |
| **Expect** | the answer quotes the file's actual content **without** a `Read` tool call — the mention was inlined before the request was sent |
| **Breaks if** | the model calls `Read`, or says it cannot see the file |

### P-13 · Nested MINI.md precedence — **[LIVE]**

| | |
|---|---|
| **Setup** | `npm run dev -- --cwd demo/sub` |
| **Prompt** | `what indentation should I use, and what must I never edit?` |
| **Expect** | it cites the rules from `demo/MINI.md` (tabs; never edit `generated/`) plus whatever `demo/sub/MINI.md` adds, with the **more specific file winning** any conflict |

### P-14 · Skills — progressive disclosure and invocation — **[LIVE]**

| | |
|---|---|
| **Prompt A** | `write a commit message for the staged changes` |
| **Expect** | the model calls the `Skill` tool with `commit-message` **first**, then follows `<type>(<scope>): <subject>` |
| **Prompt B** | `what skills do you have?` |
| **Expect** | it names `commit-message` but should **not** be able to recite the body until it invokes the skill |
| **Prompt C** | touch a `.py` file first, then ask a Python question |
| **Expect** | `python-style` becomes available only after a matching file is in play (`paths: **/*.py`) |

### P-15 · Sub-agent — **[LIVE]**

| | |
|---|---|
| **Prompt** | `use a sub-agent to find every file that imports zod and summarise what each uses it for` |
| **Expect** | one `Agent` card; the sub-agent's own tool calls do not flood the main transcript; a single summary comes back |
| **Breaks if** | the sub-agent can call `Agent` itself (infinite recursion) — the pool comes from `getSubagentTools` |

### P-16 · Parallel batching — **[LIVE]**

| | |
|---|---|
| **Prompt** | `read src/query.ts, src/Tool.ts and src/tools.ts and compare their sizes` |
| **Expect** | three `Read` cards appearing **together**, results in the order requested |

### P-17 · Plan mode — **[LIVE]**

| | |
|---|---|
| **Setup** | `/mode plan` |
| **Prompt** | `add a --verbose flag to the CLI` |
| **Expect** | it reads and greps freely, writes nothing, and finishes by calling `ExitPlanMode` with a plan. Approving flips the mode to `acceptEdits`; only then do edits land. |
| **Breaks if** | any file changes before you approve |

### P-18 · Todos — **[LIVE]**

| | |
|---|---|
| **Prompt** | `add a health check endpoint, write a test for it, and update the readme` |
| **Expect** | the todo panel appears; exactly **one** item is `▶ in_progress` at any moment; the counter advances |

### P-19 · Slash commands — **[STUB]** for the local ones, **[LIVE]** for prompt-expanding ones

| Command | Expect |
|---|---|
| `/help` | lists built-ins **and** `explain`, `test` from `.mini-cc/commands/` |
| `/context` | a token breakdown that sums to roughly the reported total |
| `/cost` | non-zero after at least one real turn; `$0.00` on the stub is fine |
| `/model` | prints `gpt-5` (from `.mini-cc/settings.json`); `/model gpt-4o` switches for the session; `--save` persists it |
| `/mode plan` | mode changes and the tool list shrinks |
| `/clear` | history gone, `/context` drops back to the base prompt |
| `/compact` | message count drops, the conversation still makes sense afterwards |
| `/sessions` | lists this project's saved sessions |
| `/doctor` | see P-21 |
| `/explain src/query.ts` | **[LIVE]** expands the markdown file's body with `$ARGUMENTS` substituted, then answers with line citations |
| `/nope` | an unknown-command message, not a crash |

### P-20 · Compaction under real pressure — **[LIVE]**

| | |
|---|---|
| **Setup** | `npm run dev -- -m gpt-4` (an 8 K window, compaction threshold 4 000) |
| **Prompt** | read several large files in a row until `/context` shows the window filling |
| **Expect** | compaction fires **automatically** and the turn **continues** — recovery is a loop transition, not a throw. `/context` drops, the model still remembers the task. |
| **Breaks if** | you see a context-length error surface to the user |

### P-21 · `/doctor` — **[STUB]**

| | |
|---|---|
| **Prompt** | `/doctor` |
| **Expect** | a report with a line per check: Node.js version, API key (**prefix only — never the whole key**), base URL, model, settings files, MINI.md files found, skills, hooks, MCP servers (`broken` shown as failing), sessions, external binaries |
| **Breaks if** | a full API key appears anywhere in the output |

### P-22 · Sessions: resume and rewind — **[LIVE]**

| | |
|---|---|
| **Setup** | run a session that edits a file, then exit |
| **Then** | `npm run dev -- --continue` — history is restored and the model remembers |
| **Then** | `npm run dev -- --list-sessions` — verified format: `<uuid>  <date>  <n> msgs  <first prompt>` |
| **Then** | `npm run dev -- -r <uuid>` — resumes that specific one |
| **Then** | `/rewind 1` — **both** the messages and the edited file revert |
| **Breaks if** | messages revert but the file on disk does not |

---

## Gate 3 — CLI surface and build

Model-free, fast, easy to forget. 无需模型，很快，但最容易漏。

| # | Command | Expected |
|---|---|---|
| T-1 | `npm run dev -- --version` | `0.1.0`, near-instant — this path must not pull in Ink or the OpenAI SDK |
| T-2 | `npm run dev -- --debug` | the config block in §0.2, then exit. Confirms settings layering: defaults → `~/.mini-cc/settings.json` → `<cwd>/.mini-cc/settings.json` → flags |
| T-3 | `npm run dev -- --debug -m gpt-4o` | `model: gpt-4o` — the flag beats `settings.json` |
| T-4 | `npm run dev -- --debug --permission-mode plan` | `mode: plan` |
| T-5 | `npm run dev -- --debug --add-dir C:/temp` | `add-dir: C:\temp`, and writes there are no longer path-jailed |
| T-6 | `npm run dev -- --debug -c demo` | cwd changes; `MINI.md` discovery follows it |
| T-7 | `npm run dev -- --list-sessions` | one line per session, newest first |
| T-8 | `echo hi \| npm run dev` | no TTY → the print path (`src/cli/print.ts`), plain text out, no Ink |
| T-9 | `npm run build` | `dist\mini-cc.mjs` ~3.3 mb + `dist/yoga.wasm`; verified `⚡ Done in ~4 s` |
| T-10 | `node dist/mini-cc.mjs --version` | `0.1.0` — the **bundle** works, not just `tsx`. `yoga.wasm` must be copied next to it or Ink dies at runtime. |

---

## Coverage matrix

Every file under `src/` and the test that covers it. Use this to answer "is my change tested?"
每个源文件对应的测试。改了哪一行，就跑哪一格。

| Source | Covered by |
|---|---|
| `bootstrap-entry.ts`, `entrypoints/cli.tsx`, `constants/product.ts` | T-1 … T-8 |
| `main.ts`, `utils/config.ts` | T-2, T-3, T-4, T-5, T-6 |
| `cli/print.ts` | T-8, P-1, P-2 |
| `screens/REPL.tsx` | P-1, P-5, P-17, P-18 (manual only) |
| `query.ts`, `types/message.ts` | P-1 … P-5, P-20 (manual only) |
| `services/api/client.ts` | P-1, P-3 |
| `services/api/stream.ts` | **P-2** (fragment accumulator), P-1 |
| `Tool.ts`, `tools.ts` | S-1, S-14 |
| `tools/FileReadTool.ts`, `FileWriteTool.ts`, `FileEditTool.ts`, `ListDirTool.ts` | **S-1** |
| `tools/GlobTool.ts`, `GrepTool.ts`, `utils/fileIndex.ts` | **S-2** |
| `tools/BashTool.ts`, `PowerShellTool.ts`, `utils/shell.ts` | **S-3** |
| `utils/bashParser.ts` | **S-3, S-4**, S-11 |
| `utils/permissions.ts`, `types/permissions.ts` | **S-4**, S-14, P-6 … P-8 |
| `utils/sessionStorage.ts`, `utils/fileHistory.ts`, `utils/paths.ts` | **S-5**, T-7, P-22 |
| `services/compact/compact.ts`, `utils/tokens.ts` | **S-6**, P-20 |
| `context.ts`, `constants/prompts.ts` | **S-7**, P-11, P-12, P-13 |
| `commands.ts`, `commands/builtins.ts`, `types/command.ts` | **S-8**, P-19 |
| `commands/doctor.ts` | P-21 (manual only) |
| `services/tools/toolOrchestration.ts` | **S-9**, P-16 |
| `tools/AgentTool.ts` | **S-9** (isolation), P-15 (behaviour) |
| `skills/loadSkills.ts`, `tools/SkillTool.ts` | **S-10**, P-14 |
| `utils/hooks.ts`, `types/hooks.ts` | **S-11**, P-9, P-10 |
| `services/mcp/client.ts`, `services/mcp/config.ts` | **S-12** |
| `components/ToolCard.tsx`, `components/Markdown.tsx` | **S-13** |
| `components/TodoPanel.tsx`, `tools/TodoWriteTool.ts`, `types/todo.ts`, `state/appState.ts` | **S-14**, P-18 |
| `tools/ExitPlanModeTool.ts` | **S-14**, P-17 |
| `components/PromptInput.tsx`, `Spinner.tsx`, `PermissionModal.tsx` | manual only — see gaps |
| `globals.d.ts` | Gate 0 |
| `scripts/build.mjs` | T-9, T-10 |

Bold = the automated, model-free test that would actually catch a regression there.

### Known gaps — be honest about these

以下部分**没有**自动化覆盖，改到它们时必须手工验证：

1. **`src/query.ts` has no model-free harness.** The single most important file in the program is
   verified only by hand (P-1 … P-5, P-20). Abort handling, the turn limit, and the
   compaction-and-continue path are all manual.
2. **`PromptInput.tsx`, `Spinner.tsx`, `PermissionModal.tsx` are never rendered by a smoke
   script.** `smoke-ui.tsx` covers only `ToolCard` and `Markdown`. Keyboard handling, history
   navigation and the modal's y/n/a keys are manual.
3. **The smoke scripts print; they do not assert.** Nothing fails with a non-zero exit code
   except a thrown error. A subtly wrong number slips through unless you diff (see below).
4. **`/doctor`, `--list-sessions`, and the print path have no scripted assertions.**
5. **Counts in expected output drift legitimately** as files are added (`61 file(s)`,
   `16 match(es)`). Read them as shape, not as fixtures.

Closing gap 1 or 2 means adding `tools-dev/smoke-query.ts` (drive `query.ts` against the stub
server with a scripted tool sequence) and extending `smoke-ui.tsx` with
`ink-testing-library`'s `stdin.write` for keystrokes. Both are worth doing before the next
change to those files.

---

## Golden baselines — making Gate 1 diffable

Since the smoke scripts print rather than assert, capture a baseline **before** you change
anything, then diff after. This turns "eyeball 400 lines" into "read a diff".
先存基线，再对比 diff——把「肉眼看 400 行」变成「看几行 diff」。

`tools-dev/baseline.cmd` (create it once):

```
@echo off
set OUT=%1
if "%OUT%"=="" set OUT=baseline
mkdir %OUT% 2>nul
for %%s in (smoke smoke-search smoke-shell smoke-permissions smoke-compact smoke-context smoke-commands smoke-parallel smoke-skills smoke-hooks smoke-mcp) do (
  npx tsx tools-dev/%%s.ts > %OUT%\%%s.txt 2>&1
)
npx tsx tools-dev/smoke-ui.tsx  > %OUT%\smoke-ui.txt  2>&1
npx tsx tools-dev/smoke-todo.tsx > %OUT%\smoke-todo.txt 2>&1
echo wrote %OUT%
```

```
:: before your change
tools-dev\baseline.cmd before
:: ... make the change ...
tools-dev\baseline.cmd after
git diff --no-index before after
```

Excluded on purpose: `smoke-sessions.ts` (fresh UUIDs and a temp path every run) and the dice
roll inside `smoke-mcp.ts` — those two always differ.

**Every line in the diff must be one you intended.** An unexplained change to a permission
decision, a token count, or a BLOCKED message is the regression you were looking for.

---

## The checklist

Paste this into the PR / commit description.
提交前把这张表跑一遍。

```
[ ] Gate 0  npm run typecheck                       -> clean
[ ] Gate 1  every smoke script for the touched rows of the coverage matrix
[ ] Gate 1  smoke-permissions.ts                    -> no deny/ask became allow
[ ] Gate 2  the prompt tests for the touched subsystem
[ ] Gate 3  npm run build && node dist/mini-cc.mjs --version
[ ] MINI.md convention: every new .ts/.tsx opens with // 本文件：…
[ ] MINI.md convention: every new function/class/tool/command has its 本函数/本类/本命令 line
[ ] MINI.md convention: every new English comment has its condensed Chinese line below it
[ ] cf. … references added for any file mirroring a real Claude Code module
[ ] Chapter N markers preserved on anything still stubbed
```

The last five are not style points in this repo — the file layout and the bilingual comments
**are the deliverable**. A change that passes all four gates and drops a `// 本文件：` line is
still an incomplete change.
最后五条不是格式洁癖：在这个项目里，文件布局与双语注释本身就是交付物。
