// 本文件：TodoWrite 工具，让模型维护本次工作的待办清单（整份替换，不是增量）。
import { z } from 'zod'
import { buildTool } from '../Tool.js'
import { TodoListSchema } from '../types/todo.js'

const schema = z.strictObject({
  todos: TodoListSchema.describe('The COMPLETE list. Send every item every time, not a delta.'),
})

/**
 * The agent's own task list.
 * 代理自己的任务清单。
 *
 * The simplest tool in the codebase, and one of the most useful. Two reasons:
 * 全代码库最简单、也最有用的工具之一。原因有二：
 *
 *   1. FOR THE USER — a long task stops being an opaque wall of tool calls and
 *      becomes a checklist with visible progress.
 *      对用户——长任务不再是一堵不透明的工具调用墙，而是可见进度的清单。
 *   2. FOR THE MODEL — writing the plan down keeps it on task. A model that has
 *      listed five steps is far less likely to do three of them and declare
 *      victory. The list is externalised working memory.
 *      对模型——把计划写下来能让它不跑题。列了五步的模型，很难做完三步就宣告完工。
 *      清单就是外置的工作记忆。
 *
 * Note what it does NOT do: it does not render a result into the transcript.
 * The list has its own panel, so a result line would be duplication. The Tool
 * contract makes `renderResult` optional precisely for this case.
 * 注意它不做什么：不向会话记录渲染结果。清单有自己的面板，再写一行就是重复。
 * Tool 契约把 `renderResult` 设为可选，正是为这种情况。
 *
 * cf. src/tools/TodoWriteTool/ in the Claude Code tree.
 * 参见 Claude Code 的 src/tools/TodoWriteTool/。
 */
export const TodoWriteTool = buildTool({
  name: 'TodoWrite',
  description:
    'Create and update a task list for the current piece of work. Use this for any ' +
    'task with three or more steps, or when the user gives you several things to do. ' +
    'Send the COMPLETE list every time — it replaces the previous one. ' +
    'Mark exactly one task in_progress while you work on it, and mark it completed ' +
    'as soon as it is done, before starting the next. Do not batch completions. ' +
    'Skip this tool entirely for a single trivial step; a checklist of one is noise.',
  inputSchema: schema,

  // It touches nothing outside the process, so it never needs approval.
  // 它不触及进程之外的任何东西，因此永远不需要批准。
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ behavior: 'allow' }),

  renderCall: () => 'TodoWrite',
  // Deliberately absent: the todo panel is the result.
  // 刻意留空：待办面板本身就是结果。
  renderResult: undefined,

  validateInput(input) {
    const active = input.todos.filter(todo => todo.status === 'in_progress')
    if (active.length > 1) {
      return {
        ok: false,
        message:
          `${active.length} tasks are marked in_progress. Exactly one task may be ` +
          'in progress at a time — finish or re-queue the others.',
      }
    }
    return { ok: true }
  },

  async execute(input, ctx) {
    const key = ctx.agentId ?? 'main'
    const previous = ctx.appState.todos[key] ?? []
    ctx.appState.todos[key] = input.todos

    const done = input.todos.filter(todo => todo.status === 'completed').length
    const current = input.todos.find(todo => todo.status === 'in_progress')

    return {
      // Short and factual: the model does not need its own list read back to it.
      // 简短而实在：模型不需要把自己写的清单再读回去。
      result:
        `Todo list updated (${done}/${input.todos.length} complete).` +
        (current ? ` Now: ${current.activeForm}.` : ''),
      data: { previous, todos: input.todos },
    }
  },
})
