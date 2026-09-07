/**
 * Exercise Glob and Grep against this project's own tree.
 * 用本项目自身的目录树跑一遍 Glob 与 Grep。
 */
import { getAllTools } from '../src/tools.js'
import type { ToolContext } from '../src/Tool.js'

const ctx: ToolContext = {
  cwd: process.cwd(),
  abortController: new AbortController(),
  readFileState: new Map(),
}
const tools = new Map(getAllTools().map(t => [t.name, t]))

async function call(name: string, input: unknown, head = 6): Promise<void> {
  const tool = tools.get(name)!
  const parsed = tool.inputSchema.safeParse(input)
  if (!parsed.success) {
    console.log(`${name}: SCHEMA ERROR ${parsed.error.issues[0]?.message}`)
    return
  }
  const out = await tool.execute(parsed.data, ctx)
  console.log(`${name} ${JSON.stringify(input)}`)
  console.log(`  -> ${tool.renderResult?.(out, parsed.data) ?? ''}`)
  console.log(
    out.result
      .split('\n')
      .slice(0, head)
      .map(l => `     ${l}`)
      .join('\n'),
  )
  console.log()
}

await call('Glob', { pattern: '**/*.ts' })
await call('Glob', { pattern: 'src/tools/*.ts' })
await call('Glob', { pattern: '**/*.nope' }, 2)
await call('Grep', { pattern: 'buildTool', glob: '**/*.ts' })
await call('Grep', { pattern: 'readFileState', glob: 'src/**/*.ts', output_mode: 'count' })
await call('Grep', { pattern: 'export const \\w+Tool', glob: 'src/**/*.ts', output_mode: 'content' })
// node_modules must be pruned: this would take forever otherwise.
// 必须剪掉 node_modules，否则这一步会慢得没边。
console.time('glob-all')
await call('Glob', { pattern: '**/*' }, 3)
console.timeEnd('glob-all')
