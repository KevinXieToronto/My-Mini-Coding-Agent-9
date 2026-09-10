// 本文件：极简单行输入编辑器组件，负责收集用户输入并在回车时提交。
import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type React from 'react'

/**
 * A minimal line editor.
 * 一个极简的行编辑器。
 *
 * Ink ships a TextInput component, but writing the twenty lines yourself makes
 * the keypress model obvious — and that keypress model is what slash-command
 * autocomplete would build on. Chapter 13 wires up slash commands on submit and
 * leaves the autocomplete itself as an exercise, so this editor stays minimal.
 * Ink 自带 TextInput，但自己写这二十行能把按键模型讲清楚——斜杠命令的自动补全
 * 正要建立在这个按键模型上。第 13 章只在提交时接入斜杠命令，自动补全留作练习，
 * 因此这个编辑器保持最小实现。
 */
// 本组件：最小行编辑器，处理回车提交、退格删除与普通字符输入。
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
    if (input && !key.ctrl && !key.meta) setValue(previous => previous + input)  // 排除 ctrl/meta 组合键，免得 Ctrl+C 之类的按键把控制字符写进输入框
  })

  return (
    <Box marginTop={1}>
      <Text color="blue" bold>{'> '}</Text>
      <Text>{value}</Text>
      <Text inverse> </Text>
    </Box>
  )
}
