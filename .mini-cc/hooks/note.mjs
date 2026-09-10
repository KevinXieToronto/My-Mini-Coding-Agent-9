// 本文件：PostToolUse 钩子示例——只往对话里追加一行注记，什么也不阻止。
let raw = ''
process.stdin.on('data', c => (raw += c))
process.stdin.on('end', () => {
  const event = JSON.parse(raw)
  console.log(
    JSON.stringify({
      additionalContext: `[note] ${event.hook_event_name} saw ${event.tool_name ?? 'a prompt'}`,
    }),
  )
})
