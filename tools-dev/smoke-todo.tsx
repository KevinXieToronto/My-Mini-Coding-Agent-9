// 本文件：待办清单与 plan 模式的冒烟脚本——校验校验器、面板渲染、模式相关工具表与权限例外。
import { render } from 'ink-testing-library'
import { TodoWriteTool } from '../src/tools/TodoWriteTool.js'
import { ExitPlanModeTool } from '../src/tools/ExitPlanModeTool.js'
import { TodoPanel } from '../src/components/TodoPanel.js'
import { evaluatePermission } from '../src/utils/permissions.js'
import { getAllTools } from '../src/tools.js'
import type { Tool } from '../src/Tool.js'
import { makeContext } from './testContext.js'

const ctx = makeContext()

console.log('--- two in_progress is rejected ---')
console.log(
  ' ',
  TodoWriteTool.validateInput!(
    {
      todos: [
        { content: 'a', activeForm: 'doing a', status: 'in_progress' },
        { content: 'b', activeForm: 'doing b', status: 'in_progress' },
      ],
    },
    ctx,
  ),
)

const todos = [
  {
    content: 'Read the server module',
    activeForm: 'Reading the server module',
    status: 'completed' as const,
  },
  {
    content: 'Add a health check route',
    activeForm: 'Adding a health check route',
    status: 'in_progress' as const,
  },
  {
    content: 'Write a test for it',
    activeForm: 'Writing a test for it',
    status: 'pending' as const,
  },
]
const out = await TodoWriteTool.execute({ todos }, ctx)
console.log('  model sees:', JSON.stringify(out.result))
console.log(render(<TodoPanel todos={todos} version={0} />).lastFrame())

console.log('\n--- ExitPlanMode is only advertised in plan mode ---')
console.log(
  '  default:',
  getAllTools('default')
    .map(t => t.name)
    .join(', '),
)
console.log(
  '  plan   :',
  getAllTools('plan')
    .map(t => t.name)
    .join(', '),
)

console.log('\n--- plan mode blocks writes but lets ExitPlanMode through ---')
const planCtx = makeContext({ mode: 'plan' })
const tools = new Map(getAllTools('plan').map(t => [t.name, t]))
for (const [name, input] of [
  ['Read', { file_path: 'x.ts' }],
  ['Edit', { file_path: 'x.ts', old_string: 'a', new_string: 'b' }],
  ['Bash', { command: 'npm install' }],
  ['TodoWrite', { todos: [] }],
  ['ExitPlanMode', { plan: 'do the thing' }],
] as const) {
  const decision = evaluatePermission(tools.get(name) as Tool, input, planCtx)
  console.log(`  ${name.padEnd(14)} ${decision.behavior.padEnd(6)} (${decision.reason.type})`)
}

console.log('\n--- approving the plan flips the mode ---')
planCtx.permissions.prePlanMode = 'acceptEdits'
console.log('  before:', planCtx.permissions.mode)
await ExitPlanModeTool.execute({ plan: 'do the thing' }, planCtx)
console.log('  after :', planCtx.permissions.mode)
