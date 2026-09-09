// 本文件：会话记录与文件回退的冒烟脚本，不经过模型验证追加、重放、容错与回滚。
/**
 * Exercise transcript persistence and rewind, with no model in the loop.
 * 不经过模型，直接演练会话记录持久化与回退。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionWriter,
  listSessions,
  messagesFromTranscript,
  readTranscript,
  slugForCwd,
} from '../src/utils/sessionStorage.js'
import { FileHistory } from '../src/utils/fileHistory.js'
import type { Message } from '../src/types/message.js'

const cwd = mkdtempSync(join(tmpdir(), 'minicc-sess-'))
console.log(`cwd  : ${cwd}`)
console.log(`slug : ${slugForCwd(cwd)}`)

console.log('\n--- transcript chain ---')
const writer = new SessionWriter(cwd)
const messages: Message[] = [
  { role: 'user', content: 'add a health check' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Edit', arguments: '{}' }] },
  { role: 'tool', toolCallId: 'c1', content: 'Applied 1 replacement(s).' },
  { role: 'assistant', content: 'Done.' },
]
for (const message of messages) writer.append(message)

const entries = readTranscript(writer.path)
for (const entry of entries) {
  console.log(
    `  ${entry.uuid.slice(0, 8)}  parent=${entry.parentUuid?.slice(0, 8) ?? 'null    '}  ${entry.message.role}`,
  )
}
console.log(
  '  matches original:',
  JSON.stringify(messagesFromTranscript(entries)) === JSON.stringify(messages),
)
console.log('  listSessions     :', listSessions(cwd).map(s => s.preview))

console.log('\n--- torn last line ---')
// A torn last line must not lose the file.
// 残缺的末行不能导致整个文件报废。
writeFileSync(writer.path, `${readFileSync(writer.path, 'utf8')}{"uuid":"broke`, 'utf8')
console.log('  entries after corruption:', readTranscript(writer.path).length)

console.log('\n--- rewind restores files ---')
// Rewind restores files.
// 回退会把文件恢复原状。
const target = join(cwd, 'app.ts')
writeFileSync(target, 'original\n', 'utf8')
const history = new FileHistory()
history.track(target, 2)
writeFileSync(target, 'edited once\n', 'utf8')
history.track(target, 4)
writeFileSync(target, 'edited twice\n', 'utf8')
console.log('  on disk now      :', JSON.stringify(readFileSync(target, 'utf8')))
history.rewindTo(4)
console.log('  after rewind to 4:', JSON.stringify(readFileSync(target, 'utf8')))
history.rewindTo(2)
console.log('  after rewind to 2:', JSON.stringify(readFileSync(target, 'utf8')))
