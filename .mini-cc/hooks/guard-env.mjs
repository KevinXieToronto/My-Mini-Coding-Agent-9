// 本文件：PreToolUse 钩子示例——凡是碰 .env 的写操作一律拒绝。
let raw = ''
process.stdin.on('data', c => (raw += c))
process.stdin.on('end', () => {
  const event = JSON.parse(raw)
  const path = String(event.tool_input?.file_path ?? '')
  if (path.includes('.env')) {
    console.log(
      JSON.stringify({
        permissionDecision: 'deny',
        permissionDecisionReason: 'Secrets live in .env; ask a human to change it.',
      }),
    )
  }
})
