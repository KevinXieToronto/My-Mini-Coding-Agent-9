// 本文件：UI 组件的冒烟脚本，用 ink-testing-library 离屏渲染工具卡片与 Markdown 并打印结果。
import { render } from 'ink-testing-library'
import { ToolCard } from '../src/components/ToolCard.js'
import { renderMarkdown } from '../src/components/Markdown.js'

console.log(render(<ToolCard title="Read(src/query.ts)" status="running" />).lastFrame())
console.log(render(<ToolCard title="Grep(buildTool)" status="done" summary="15 matches in 8 files" />).lastFrame())
console.log(render(<ToolCard title="Bash(npm install)" status="denied" summary="user declined" />).lastFrame())
console.log(
  render(
    <ToolCard
      title="Edit(src/app.ts)"
      status="done"
      diff={{ before: 'const a = 1\nconst b = 2\n', after: 'const a = 1\nconst b = 3\nconst c = 4\n' }}
    />,
  ).lastFrame(),
)
console.log(renderMarkdown('# Heading\n\nSome **bold** and `code`.\n\n- one\n- two'))
