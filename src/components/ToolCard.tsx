// 本文件：转录中单次工具调用的展示卡片，负责把工具结果渲染成人类可读的摘要或彩色 diff。
import { Box, Text } from 'ink'
import { diffLines } from 'diff'
import type React from 'react'

export type ToolCardProps = {
  title: string
  status: 'running' | 'done' | 'error' | 'denied'
  summary?: string
  /**
   * Present for Edit/Write: renders a coloured diff instead of a summary.
   * Edit/Write 才有：渲染彩色 diff 而非摘要。
   */
  diff?: { before: string; after: string }
}

const STATUS_COLOUR = {
  running: 'yellow',
  done: 'green',
  error: 'red',
  denied: 'gray',
} as const

/**
 * One tool call in the transcript.
 * 转录中的一次工具调用。
 *
 * This is the component that makes each tool's `renderResult` pay off: the
 * MODEL got the full 400-line output, the HUMAN gets "12 files". Separating
 * those two audiences is the whole reason the Tool contract has renderers.
 * 这个组件让各工具的 `renderResult` 有了意义：模型拿到完整 400 行输出，人只看到「12 files」。
 * Tool 契约之所以要有渲染器，就是为了分开服务这两类受众。
 */
// 本组件：渲染一次工具调用（状态圆点 + 标题 + 摘要或 diff）。
export function ToolCard({ title, status, summary, diff }: ToolCardProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={STATUS_COLOUR[status]}>●</Text> <Text bold>{title}</Text>
      </Text>
      {diff ? (
        <DiffView before={diff.before} after={diff.after} />
      ) : summary ? (
        <Text dimColor>{'  ⎿  '}{summary}</Text>
      ) : null}
    </Box>
  )
}

const MAX_DIFF_LINES = 20

// 本组件：只显示增删行的紧凑 diff，超出上限则折叠为「还有 N 行」。
function DiffView({ before, after }: { before: string; after: string }): React.ReactElement {
  const parts = diffLines(before, after)
  const rows: React.ReactElement[] = []
  let shown = 0

  for (const [index, part] of parts.entries()) {
    if (!part.added && !part.removed) continue // context lines: skip entirely
    // 未改动的上下文行：整段跳过。
    const lines = part.value.replace(/\n$/, '').split('\n')  // diff 片段自带结尾换行，先削掉再切分，否则末尾会多出一个空行
    for (const [lineIndex, line] of lines.entries()) {
      if (shown >= MAX_DIFF_LINES) break  // 只跳出内层循环即可：shown 已达上限，外层剩余片段进来后同样立刻 break，不会再添行
      shown += 1
      rows.push(
        <Text key={`${index}-${lineIndex}`} color={part.added ? 'green' : 'red'}>
          {'  '}
          {part.added ? '+' : '-'} {line}
        </Text>,
      )
    }
  }

  const total = parts.reduce(
    (count, part) => count + (part.added || part.removed ? part.count ?? 0 : 0),  // 总数只统计增删行，与 shown 同口径，「还有 N 行」才不会把上下文行算进去
    0,
  )

  return (
    <Box flexDirection="column">
      {rows}
      {total > shown ? <Text dimColor>{`  ... ${total - shown} more changed lines`}</Text> : null}
    </Box>
  )
}
