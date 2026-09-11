// 本文件：会话记录（JSONL 转写）的写入、读取与列举，用于恢复历史会话。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Message } from '../types/message.js'
import { userConfigDir } from './config.js'

/**
 * Append-only JSONL transcripts.
 * 只追加的 JSONL 会话记录。
 *
 *   %USERPROFILE%\.mini-cc\projects\<slug-of-cwd>\<sessionId>.jsonl
 *
 * Why JSONL and not one JSON document? Because a session is written
 * incrementally and may be killed at any moment. Appending one line per entry
 * means a crash costs you the last line, not the file. And `parentUuid` gives
 * us a chain, which is what makes rewind (and Ch.11 compaction) able to prune
 * the middle of a transcript without breaking replay.
 * 为何用 JSONL 而非单个 JSON？会话是增量写入的，随时可能被杀死；每条一行意味着
 * 崩溃只损失最后一行，而非整个文件。`parentUuid` 形成链条，使回退（及第 11 章的
 * 压缩）能剪掉记录中间部分而不破坏重放。
 *
 * cf. src/utils/sessionStorage.ts in the Claude Code tree.
 * 参见 Claude Code 的 src/utils/sessionStorage.ts。
 */

export type TranscriptEntry = {
  uuid: string
  /**
   * The entry this one follows. null for the first.
   * 本条的前驱；首条为 null。
   */
  parentUuid: string | null
  timestamp: string
  sessionId: string
  type: 'message'
  message: Message
}

export type SessionSummary = {
  sessionId: string
  path: string
  updatedAt: number
  entryCount: number
  /**
   * First user message, for the picker.
   * 首条用户消息，用于会话选择器展示。
   */
  preview: string
}

/**
 * Turn a working directory into a filename-safe slug.
 * 把工作目录转成文件名安全的 slug。
 *
 * `C:\dev\my-app` -> `C--dev-my-app`. The point is that two different projects
 * never share a transcript directory, and that you can tell at a glance which
 * directory a folder belongs to.
 * 目的：不同项目绝不共用记录目录，且一眼能看出目录归属。
 */
// 本函数：把工作目录路径转换为文件名安全的 slug。
export function slugForCwd(cwd: string): string {
  return cwd
    .replace(/[\\/]/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')  // 三步依次：分隔符转连字符、非法字符转连字符、再把连续连字符压成一个
}

// 本函数：返回当前项目对应的会话记录目录。
export function projectDir(cwd: string): string {
  return join(userConfigDir(), 'projects', slugForCwd(cwd))
}

// 本函数：返回指定会话的 JSONL 记录文件路径。
export function transcriptPath(cwd: string, sessionId: string): string {
  return join(projectDir(cwd), `${sessionId}.jsonl`)
}

// 本类：会话记录写入器，按链式 uuid 追加消息条目。
export class SessionWriter {
  readonly sessionId: string
  readonly path: string
  private lastUuid: string | null = null

  constructor(
    private readonly cwd: string,
    sessionId?: string,
  ) {
    this.sessionId = sessionId ?? randomUUID()
    this.path = transcriptPath(cwd, this.sessionId)
    mkdirSync(projectDir(cwd), { recursive: true })
  }

  /**
   * Continue an existing chain after a resume.
   * 恢复会话后接续已有链条。
   */
  // 本函数：设置链条的前驱 uuid。
  setParent(uuid: string | null): void {
    this.lastUuid = uuid
  }

  // 本函数：把一条消息作为新条目追加到记录文件，并返回该条目。
  append(message: Message): TranscriptEntry {
    const entry: TranscriptEntry = {
      uuid: randomUUID(),
      parentUuid: this.lastUuid,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      type: 'message',
      message,
    }
    // Fire-and-forget append. A failed write must never take down a turn —
    // losing a transcript line is annoying; losing the user's work is not.
    // 写入失败绝不能中断一个回合：丢一行记录只是烦人，丢用户的工作则不可接受。
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      // ignore
      // 忽略
    }
    this.lastUuid = entry.uuid  // 本条 uuid 成为下一条的 parentUuid，JSONL 因而串成一条可回溯的链
    return entry
  }
}

const MAX_TRANSCRIPT_BYTES = 50_000_000

// 本函数：读取并解析 JSONL 记录文件为条目数组。
export function readTranscript(path: string): TranscriptEntry[] {
  if (!existsSync(path)) return []
  if (statSync(path).size > MAX_TRANSCRIPT_BYTES) {  // 先看文件大小再决定读不读：readFileSync 会把整份记录一次性装进内存，超大文件足以让进程 OOM
    throw new Error(`Transcript ${path} is larger than 50 MB; refusing to load.`)
  }
  const entries: TranscriptEntry[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {  // JSONL 逐行独立解析：单行损坏只丢那一行，不会毁掉整份记录
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line) as TranscriptEntry)
    } catch {
      // A torn last line after a crash. Skip it; the rest is still good.
      // 崩溃留下的残缺末行：跳过即可，其余内容仍然有效。
    }
  }
  return entries
}

/**
 * Sessions for this project, newest first.
 * 本项目的会话列表，最新在前。
 */
// 本函数：列举当前项目的所有会话摘要。
// 整体流程：1 目录不存在直接返回空 → 2 只取 .jsonl 文件 → 3 逐份读出条目，
//          取首条 user 消息作预览、mtime 作时间 → 4 滤掉空壳记录 → 5 按时间倒序排。
export function listSessions(cwd: string): SessionSummary[] {
  const dir = projectDir(cwd)
  if (!existsSync(dir)) return []

  return readdirSync(dir)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => {
      const path = join(dir, name)
      const entries = readTranscript(path)
      const firstUser = entries.find(entry => entry.message.role === 'user')  // 取首条 user 消息当预览：它是这次会话「要干什么」的最短说明，比末条更好认
      return {
        sessionId: name.replace(/\.jsonl$/, ''),
        path,
        updatedAt: statSync(path).mtimeMs,
        entryCount: entries.length,
        preview:
          firstUser && firstUser.message.role === 'user'
            ? firstUser.message.content.split('\n')[0]!.slice(0, 80)
            : '(empty)',
      }
    })
    .filter(summary => summary.entryCount > 0)  // 滤掉空记录文件——启动后没说过话就退出会留下这类空壳
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

// 本函数：返回当前项目最近一次的会话摘要。
export function mostRecentSession(cwd: string): SessionSummary | undefined {
  return listSessions(cwd)[0]
}

/**
 * Rebuild the in-memory message list from a transcript.
 * 从会话记录重建内存中的消息列表。
 */
// 本函数：把记录条目还原为消息数组。
export function messagesFromTranscript(entries: TranscriptEntry[]): Message[] {
  return entries.map(entry => entry.message)
}
