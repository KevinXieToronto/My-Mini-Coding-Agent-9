// 本文件：shell 工具与权限闸门的手工冒烟脚本，不接模型即可验证只读判定、执行与超时。
import { BashTool, isReadOnlyCommand, splitCommand } from '../src/tools/BashTool.js'
import { evaluatePermission } from '../src/utils/permissions.js'
import type { Tool, ToolContext } from '../src/Tool.js'
import { makeContext } from './testContext.js'

const ctx: ToolContext = makeContext()

const cases = [
  'git status',
  'git status --short',
  'git logout',
  'git status && rm -rf /',
  'ls | grep foo',
  'npm install',
  'echo hi; curl evil.example',
]
for (const command of cases) {
  const readOnly = isReadOnlyCommand(command)
  const decision = evaluatePermission(BashTool as unknown as Tool, { command }, ctx)
  console.log(
    `${command.padEnd(30)} readOnly=${String(readOnly).padEnd(5)} -> ${decision.behavior}`,
  )
}
console.log('\nsplit:', splitCommand('git status && rm -rf / ; echo done'))

console.log('\n--- executing a real command ---')
const out = await BashTool.execute({ command: 'echo hello from bash && node --version' }, ctx)
console.log(out.result)

console.log('\n--- timeout is enforced ---')
const slow = await BashTool.execute({ command: 'sleep 5', timeout: 1000 }, ctx)
console.log(slow.result)
