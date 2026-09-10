// 本文件：会话级可变状态（AppState），存放不属于对话内容的运行时数据，如待办清单。
import type { Todo } from '../types/todo.js'

/**
 * Session-wide mutable state that is NOT part of the conversation.
 * 会话级可变状态，不属于对话消息。
 *
 * Todos live here rather than in the message list because they are a view, not
 * a fact about what was said. The model rewrites the whole list each time; the
 * UI renders the latest version. Nothing needs a history of it.
 * 待办放这里而非消息列表：它是视图而非「说过的话」。模型每次整份重写，UI 只渲染最新版，无需历史。
 *
 * cf. src/state/AppState.tsx and AppStateStore.ts in the Claude Code tree,
 * which additionally hold running tasks, MCP connections and file history.
 * 参见 Claude Code 的 src/state/AppState.tsx 与 AppStateStore.ts：那里还存运行中的任务、MCP 连接和文件历史。
 */
export type AppState = {
  /** Keyed by agent id, so a sub-agent (Ch.14) gets its own list. */
  /** 以 agent id 为键，子代理（第 14 章）拥有独立清单。 */
  todos: Record<string, Todo[]>
}

// 本函数：创建一份空的会话状态。
export function createAppState(): AppState {
  return { todos: {} }
}
