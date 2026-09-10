// 本文件：冒烟脚本，验证工具调用的批次划分、并发上限与顺序保持，以及子代理上下文的隔离与共享。
import {
  partitionToolCalls,
  runWithConcurrency,
  createSubagentContext,
} from '../src/services/tools/toolOrchestration.js'
import { getAllTools } from '../src/tools.js'
import type { ToolCall } from '../src/types/message.js'
import { makeContext } from './testContext.js'

const byName = new Map(getAllTools().map(tool => [tool.name, tool]))

// 本函数：构造一个带随机 id 的工具调用，便于拼装测试用例。
function call(name: string, args: unknown): ToolCall {
  return { id: `c${Math.random().toString(36).slice(2, 7)}`, name, arguments: JSON.stringify(args) }
}

// 本函数：打印一组调用被划分出的批次及其并行/串行属性。
function show(label: string, calls: ToolCall[]): void {
  console.log(`  ${label}`)
  for (const batch of partitionToolCalls(calls, byName)) {
    console.log(
      `    ${batch.parallel ? 'PARALLEL' : 'serial  '}  ${batch.calls.map(c => c.name).join(', ')}`,
    )
  }
}

show('three reads', [
  call('Read', { file_path: 'a.ts' }),
  call('Read', { file_path: 'b.ts' }),
  call('Read', { file_path: 'c.ts' }),
])

show('\n  read, read, edit, read  (the ordering case)', [
  call('Read', { file_path: 'a.ts' }),
  call('Read', { file_path: 'b.ts' }),
  call('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }),
  call('Read', { file_path: 'a.ts' }),
])

show('\n  bash: read-only vs mutating', [
  call('Bash', { command: 'git status' }),
  call('Bash', { command: 'git diff' }),
  call('Bash', { command: 'npm install' }),
  call('Bash', { command: 'git log' }),
])

show('\n  malformed arguments fail closed', [
  { id: 'bad', name: 'Read', arguments: 'not json' },
  call('Read', { file_path: 'a.ts' }),
])

console.log('\n--- concurrency limit and order preservation ---')
const order: number[] = []
const tasks = Array.from({ length: 8 }, (_, i) => async () => {
  await new Promise(resolve => setTimeout(resolve, (8 - i) * 12))
  order.push(i)
  return i
})
const results = await runWithConcurrency(tasks, 3)
console.log('  completion order:', order.join(', '))
console.log('  results in order:', results.join(', '))

console.log('\n--- sub-agent context isolation ---')
const parent = makeContext()
parent.readFileState.set('C:/x.ts', { timestamp: 1, mtimeMs: 1 })
parent.sessionAllow.add('Bash')
const child = createSubagentContext(parent, 'agent_test')
console.log(
  '  own readFileState  :',
  child.readFileState.size,
  '(parent has',
  parent.readFileState.size + ')',
)
console.log('  own AbortController:', child.abortController !== parent.abortController)
console.log('  shares permissions :', child.permissions === parent.permissions)
console.log('  shares fileHistory :', child.fileHistory === parent.fileHistory)
child.sessionAllow.add('Write')
console.log('  child grant leaks? :', parent.sessionAllow.has('Write'))

console.log('\n--- aborting the parent aborts the child ---')
console.log('  before:', child.abortController.signal.aborted)
parent.abortController.abort('interrupt')
console.log('  after :', child.abortController.signal.aborted)
