// 本文件：钩子引擎的手动冒烟脚本，不经模型直接验证匹配、拒绝与上下文注入。
import { loadSettings } from '../src/utils/config.js'
import { matcherApplies, runContextHooks, runPreToolUseHooks } from '../src/utils/hooks.js'

const cwd = process.cwd()
const hooks = loadSettings(cwd).hooks ?? {}
console.log('loaded events:', Object.keys(hooks))

console.log('regex matcher  Edit  ->', matcherApplies('Edit|Write', 'Edit', {}))
console.log('regex matcher  Read  ->', matcherApplies('Edit|Write', 'Read', {}))
console.log('rule  Bash(git push *) / git push --force ->', matcherApplies('Bash(git push *)', 'Bash', { command: 'git push --force' }))
console.log('rule  Bash(git push *) / git status       ->', matcherApplies('Bash(git push *)', 'Bash', { command: 'git status' }))

const denied = await runPreToolUseHooks(
  hooks,
  { hook_event_name: 'PreToolUse', session_id: 's', cwd, tool_name: 'Write', tool_input: { file_path: '.env' } },
  cwd,
)
console.log('PreToolUse .env  ->', denied)

const allowed = await runPreToolUseHooks(
  hooks,
  { hook_event_name: 'PreToolUse', session_id: 's', cwd, tool_name: 'Write', tool_input: { file_path: 'src/x.ts' } },
  cwd,
)
console.log('PreToolUse src   ->', allowed)

const post = await runContextHooks(
  hooks,
  'PostToolUse',
  { hook_event_name: 'PostToolUse', session_id: 's', cwd, tool_name: 'Edit', tool_input: {}, tool_response: 'ok' },
  cwd,
)
console.log('PostToolUse      ->', post)
