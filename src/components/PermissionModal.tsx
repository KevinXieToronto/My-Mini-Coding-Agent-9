// 本文件：工具执行前的授权确认弹窗组件，把代理循环的 await 挂在 UI 上等待用户按键。
import { Box, Text, useInput } from 'ink'
import type React from 'react'

export type PermissionRequest = {
  message: string
  toolName: string
  resolve: (answer: 'yes' | 'no' | 'always') => void
}

// 本组件：渲染授权提示并把按键（y / a / n）回传给等待中的 Promise。
/**
 * The approval prompt, as a React component.
 * 以 React 组件形式呈现的授权提示。
 *
 * The important thing here is not the box drawing — it is that the agent loop
 * is SUSPENDED while this renders. `canUseTool` returns a promise; this
 * component holds its resolver; the loop is sitting in an `await` in the middle
 * of a turn. The UI is literally inside the loop's await chain.
 * 关键不是画框，而是它渲染期间代理循环处于挂起状态：`canUseTool` 返回一个 Promise，
 * 本组件持有它的 resolver，循环则停在回合中间的 `await` 上——UI 就长在循环的 await 链里。
 *
 * cf. src/components/permissions/PermissionRequest.tsx.
 * 参见 src/components/permissions/PermissionRequest.tsx。
 */
export function PermissionModal({ request }: { request: PermissionRequest }): React.ReactElement {
  useInput((input, key) => {
    const answer = input.toLowerCase()
    if (answer === 'y') request.resolve('yes')
    else if (answer === 'a') request.resolve('always')
    else if (answer === 'n' || key.escape || key.return) request.resolve('no')
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text bold color="yellow">
        Permission required
      </Text>
      <Text>{request.message}</Text>
      <Box marginTop={1}>
        <Text dimColor>
          <Text color="green">y</Text> allow once {'  '}
          <Text color="green">a</Text> always allow {request.toolName} {'  '}
          <Text color="red">n</Text> deny (default)
        </Text>
      </Box>
    </Box>
  )
}
