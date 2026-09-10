// 本文件：文件改动前的快照记录与回滚，为 /rewind 提供文件层面的撤销能力。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Checkpoints for rewind.
 * 供回退使用的检查点。
 *
 * Every mutating file tool records the file's contents BEFORE it changes them.
 * Rewinding to turn N then means: truncate the message list, and restore every
 * file to the content it had at turn N.
 * 每个会改动文件的工具都在动手前记录原内容；回退到第 N 回合即：截断消息列表，
 * 并把所有文件恢复到第 N 回合时的内容。
 *
 * Rewinding messages without rewinding files is worse than not rewinding at
 * all — you would get a conversation that believes the edits never happened,
 * against a working tree where they did.
 * 只回退消息而不回退文件，比不回退更糟：对话以为编辑没发生过，工作区却已改。
 *
 * cf. src/utils/fileHistory.ts, which keys backups by content hash and is
 * what the /rewind command restores from.
 * 参见 Claude Code 的 src/utils/fileHistory.ts：按内容哈希索引备份，/rewind 由此恢复。
 */

export type FileCheckpoint = {
  path: string
  /**
   * undefined means "did not exist" — restoring blanks the file.
   * undefined 表示「原本不存在」，恢复时把文件清空。
   */
  content: string | undefined
  /**
   * Index into the message list at the time of the edit.
   * 编辑发生时在消息列表中的下标。
   */
  messageIndex: number
}

// 本类：保存文件改动前快照，并支持按消息下标回滚。
export class FileHistory {
  private readonly checkpoints: FileCheckpoint[] = []

  /**
   * Record the pre-edit state, once per file per turn. Recording every edit
   * would be redundant: to undo a whole turn we only need the state before its
   * first change.
   * 每回合每文件只记录一次改动前状态；撤销整个回合只需其首次改动前的内容。
   */
  // 本函数：记录指定文件在该回合改动前的内容快照。
  track(path: string, messageIndex: number): void {
    if (this.checkpoints.some(c => c.path === path && c.messageIndex === messageIndex)) return
    this.checkpoints.push({
      path,
      content: existsSync(path) ? readFileSync(path, 'utf8') : undefined,
      messageIndex,
    })
  }

  /**
   * Files that would change if we rewound to `messageIndex`.
   * 回退到 `messageIndex` 时会被改动的文件列表。
   */
  // 本函数：返回回退到该下标时受影响的文件路径。
  affectedBy(messageIndex: number): string[] {
    return [
      ...new Set(this.checkpoints.filter(c => c.messageIndex >= messageIndex).map(c => c.path)),
    ]
  }

  /**
   * Restore every file to its state at `messageIndex`, and forget the
   * checkpoints we consumed.
   * 把所有文件恢复到 `messageIndex` 时的状态，并丢弃已消费的检查点。
   *
   * Applied in REVERSE order so that the OLDEST checkpoint for a file is the
   * one that ends up on disk.
   * 逆序应用，确保同一文件最终落盘的是最早的那份快照。
   */
  // 本函数：回退到指定消息下标，恢复文件内容并返回已恢复的路径。
  rewindTo(messageIndex: number): string[] {
    const toRestore = this.checkpoints
      .filter(c => c.messageIndex >= messageIndex)
      .sort((a, b) => b.messageIndex - a.messageIndex)

    const restored = new Set<string>()
    for (const checkpoint of toRestore) {
      try {
        if (checkpoint.content === undefined) {
          // The file did not exist before; the closest we get to "undo create"
          // without deleting user data is to blank it.
          // 文件原本不存在；在不删除用户数据的前提下，清空是最接近「撤销创建」的做法。
          writeFileSync(checkpoint.path, '', 'utf8')
        } else {
          writeFileSync(checkpoint.path, checkpoint.content, 'utf8')
        }
        restored.add(checkpoint.path)
      } catch {
        // A file the user has since deleted or locked. Skip it.
        // 用户已删除或锁定的文件：跳过。
      }
    }

    this.checkpoints.splice(
      0,
      this.checkpoints.length,
      ...this.checkpoints.filter(c => c.messageIndex < messageIndex),
    )
    return [...restored]
  }

  get size(): number {
    return this.checkpoints.length
  }
}
