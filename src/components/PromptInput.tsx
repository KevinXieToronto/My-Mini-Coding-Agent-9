// 本文件：极简单行输入编辑器组件，负责收集用户输入并在回车时提交。
import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type React from 'react'

// 本组件：最小行编辑器，处理回车提交、退格删除与普通字符输入。
/**
 * A minimal line editor.
 * 一个极简的行编辑器。
 *
 * Ink ships a TextInput component, but writing the twenty lines yourself makes
 * the keypress model obvious — and the keypress model is what Chapter 13's
 * slash-command autocomplete builds on.
 * Ink 自带 TextInput，但自己写这二十行能把按键模型讲清楚——
 * 而第 13 章的斜杠命令自动补全正是建立在这个按键模型上。
 */
export function PromptInput({
  onSubmit,
}: {
  onSubmit: (text: string) => void
}): React.ReactElement {
  const [value, setValue] = useState('')

  useInput((input, key) => {
    if (key.return) {
      const text = value.trim()
      setValue('')
      if (text) onSubmit(text)
      return
    }
    if (key.backspace || key.delete) {
      setValue(previous => previous.slice(0, -1))
      return
    }
    // Ignore control keys; `input` is empty for most of them.
    // 忽略控制键；它们大多不会带来 `input` 内容。
    if (input && !key.ctrl && !key.meta) setValue(previous => previous + input)
  })

  return (
    <Box marginTop={1}>
      <Text color="blue" bold>{'> '}</Text>
      <Text>{value}</Text>
      <Text inverse> </Text>
    </Box>
  )
}
