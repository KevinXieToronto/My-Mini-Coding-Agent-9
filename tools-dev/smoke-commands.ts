// 本文件：斜杠命令的冒烟测试——不接模型，直接验证命令解析、参数替换、markdown 命令加载与别名。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  findCommand,
  getCommands,
  parseCommandLine,
  splitFrontmatter,
  substituteArguments,
} from '../src/commands.js'

const cwd = process.cwd()

console.log('--- parsing a command line ---')
for (const line of ['/help', '/review src/app.ts', '/mode plan', 'not a command']) {
  console.log(`  ${line.padEnd(22)}`, parseCommandLine(line))
}

console.log('\n--- argument substitution ---')
console.log(' ', substituteArguments('Review $1 and $2, all args: $ARGUMENTS', 'a.ts b.ts'))
console.log(' ', substituteArguments('Missing: $3', 'only-one'))

console.log('\n--- frontmatter ---')
console.log(' ', splitFrontmatter('---\ndescription: hi\n---\nbody text'))

console.log('\n--- a project command file ---')
mkdirSync(join(cwd, '.mini-cc', 'commands'), { recursive: true })
writeFileSync(
  join(cwd, '.mini-cc', 'commands', 'explain.md'),
  [
    '---',
    'description: Explain a file in depth',
    'argument-hint: <path>',
    '---',
    'Read $ARGUMENTS and explain what it does, why it exists, and what would',
    'break if it were removed. Be concrete and cite line numbers.',
  ].join('\n'),
  'utf8',
)

const commands = getCommands(cwd)
console.log('  registry:', commands.map(c => c.name).sort().join(', '))

const explain = findCommand(commands, 'explain')
if (explain?.type === 'prompt') {
  console.log('  source:', explain.source, '| hint:', explain.argumentHint)
  console.log('  expands to:', (await explain.getPrompt('src/query.ts', {} as never)).slice(0, 70))
}

console.log('\n--- aliases ---')
console.log('  /? ->', findCommand(commands, '?')?.name)
console.log('  /quit ->', findCommand(commands, 'quit')?.name)
console.log('  /nope ->', findCommand(commands, 'nope'))
