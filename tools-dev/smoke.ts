// 本文件：文件类工具的冒烟脚本，不经过模型直接验证各条护栏与正常路径。
/**
 * Exercise the tools directly, with no model in the loop.
 * 不经过模型，直接演练各个工具。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAllTools } from '../src/tools.js'
import type { ToolContext } from '../src/Tool.js'

const cwd = mkdtempSync(join(tmpdir(), 'minicc-'))
writeFileSync(join(cwd, 'hello.txt'), 'alpha\nbeta\ngamma\n', 'utf8')

const ctx: ToolContext = {
  cwd,
  abortController: new AbortController(),
  readFileState: new Map(),
}

const tools = new Map(getAllTools().map(t => [t.name, t]))

// 本函数：模拟代理的工具分发（schema 校验 → validateInput → execute）并打印结果摘要。
async function call(name: string, input: unknown): Promise<void> {
  const tool = tools.get(name)!
  const parsed = tool.inputSchema.safeParse(input)
  if (!parsed.success) {
    console.log(`${name}: SCHEMA ERROR ${parsed.error.issues[0]?.message}`)
    return
  }
  const validation = tool.validateInput?.(parsed.data, ctx)
  if (validation && !validation.ok) {
    console.log(`${name}: BLOCKED — ${validation.message}`)
    return
  }
  const out = await tool.execute(parsed.data, ctx)
  console.log(`${name}: OK\n${out.result.split('\n').slice(0, 4).join('\n')}`)
}

console.log('--- 1. Edit before Read must be blocked ---')
await call('Edit', { file_path: 'hello.txt', old_string: 'beta', new_string: 'BETA' })

console.log('\n--- 2. Read ---')
await call('Read', { file_path: 'hello.txt' })

console.log('\n--- 3. Edit now allowed ---')
await call('Edit', { file_path: 'hello.txt', old_string: 'beta', new_string: 'BETA' })

console.log('\n--- 4. Non-unique old_string must be blocked ---')
writeFileSync(join(cwd, 'dup.txt'), 'x\nx\n', 'utf8')
await call('Read', { file_path: 'dup.txt' })
await call('Edit', { file_path: 'dup.txt', old_string: 'x', new_string: 'y' })

console.log('\n--- 5. replace_all allowed ---')
await call('Edit', { file_path: 'dup.txt', old_string: 'x', new_string: 'y', replace_all: true })

console.log('\n--- 6. Unknown key rejected by strictObject ---')
await call('Read', { file_path: 'hello.txt', bogus: 1 })

console.log('\n--- 7. Write a new file needs no prior Read ---')
await call('Write', { file_path: 'sub/new.txt', content: 'fresh\n' })

console.log('\n--- 8. Overwrite an unread existing file is blocked ---')
writeFileSync(join(cwd, 'other.txt'), 'precious\n', 'utf8')
await call('Write', { file_path: 'other.txt', content: 'clobbered\n' })

console.log('\n--- 9. Stale edit is blocked ---')
await call('Read', { file_path: 'hello.txt' })
await new Promise(r => setTimeout(r, 20))
writeFileSync(join(cwd, 'hello.txt'), 'changed externally\n', 'utf8')
await call('Edit', { file_path: 'hello.txt', old_string: 'changed', new_string: 'CHANGED' })

console.log('\n--- 10. ListDir ---')
await call('ListDir', { path: '.' })
