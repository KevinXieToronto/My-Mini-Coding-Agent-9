// 本文件：待办清单面板组件，在固定位置就地重绘任务清单，不随会话记录滚走。
import { Box, Text } from 'ink'
import type { Todo } from '../types/todo.js'

const MARK = {
  pending: { icon: '☐', colour: 'gray' },
  in_progress: { icon: '▶', colour: 'yellow' },
  completed: { icon: '☑', colour: 'green' },
} as const

/**
 * The todo list, rendered in its own panel rather than inline in the
 * transcript.
 * 待办清单渲染在独立面板里，而不是嵌在会话记录中。
 *
 * That is why TodoWriteTool has no renderResult: a checklist that scrolled
 * away with the rest of the transcript would defeat the purpose. It lives at a
 * fixed place on screen and is rewritten in place.
 * 这正是 TodoWriteTool 不设 renderResult 的原因：随记录滚走的清单便失去了意义。
 * 它固定在屏幕一处，就地重写。
 */
// 本组件：渲染待办清单面板；清单为空时不渲染任何内容。
export function TodoPanel({
  todos,
  version,
}: {
  todos: Todo[]
  version: number
}): React.ReactElement | null {
  void version // only here to force a re-render when the list is mutated
  // 仅用于在清单被就地修改时触发重渲染。
  if (todos.length === 0) return null

  const done = todos.filter(todo => todo.status === 'completed').length

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text dimColor>
        Tasks {done}/{todos.length}
      </Text>
      {todos.map((todo, index) => {
        const mark = MARK[todo.status]
        return (
          <Text key={index} color={mark.colour} strikethrough={todo.status === 'completed'}>
            {mark.icon} {todo.status === 'in_progress' ? todo.activeForm : todo.content}
          </Text>
        )
      })}
    </Box>
  )
}
