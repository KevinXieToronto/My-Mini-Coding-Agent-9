// 本文件：把 Markdown 渲染成带 ANSI 样式的字符串，并提供对应的 Ink 组件，用于终端输出助手回复。
import { Text } from 'ink'
import { marked } from 'marked'
import chalk from 'chalk'
import type React from 'react'
import type { Tokens } from 'marked'

/**
 * Render markdown to ANSI text.
 * 把 Markdown 渲染成 ANSI 文本。
 *
 * We do not build a React tree per markdown node — we produce one styled
 * string and hand it to a single <Text>. Terminal markdown is mostly inline
 * styling, and a flat string reflows correctly when the window is resized,
 * whereas nested Ink boxes fight the layout engine.
 * 不为每个 Markdown 节点建 React 树，而是产出一个带样式的字符串交给单个 <Text>。
 * 终端 Markdown 基本只是行内样式；扁平字符串在窗口缩放时能正确重排，嵌套 Ink Box 则会与布局引擎冲突。
 */
// 本函数：把 Markdown 源文本渲染为单个 ANSI 字符串。
export function renderMarkdown(source: string): string {
  const tokens = marked.lexer(source)
  return tokens.map(renderToken).join('').trimEnd()
}

// 本函数：按 token 类型渲染单个块级节点，未知类型退化为纯文本。
function renderToken(token: Tokens.Generic): string {
  switch (token.type) {
    case 'heading':
      return `${chalk.bold.cyan(inline((token as Tokens.Heading).text))}\n\n`
    case 'paragraph':
      return `${inline((token as Tokens.Paragraph).text)}\n\n`
    case 'code': {
      const code = token as Tokens.Code
      const body = code.text
        .split('\n')
        .map(line => chalk.green(`  ${line}`))
        .join('\n')
      return `${chalk.dim(`  ${code.lang ?? ''}`)}\n${body}\n\n`
    }
    case 'list': {
      const list = token as Tokens.List
      return (
        list.items
          .map((item, index) => {
            const bullet = list.ordered ? `${index + 1}.` : '•'
            return `  ${chalk.cyan(bullet)} ${inline(item.text)}`
          })
          .join('\n') + '\n\n'
      )
    }
    case 'blockquote':
      return `${chalk.dim(`  ▏${inline((token as Tokens.Blockquote).text)}`)}\n\n`
    case 'hr':
      return `${chalk.dim('  ───')}\n\n`
    case 'space':
      return ''
    default:
      return 'text' in token ? `${String(token.text)}\n\n` : ''
  }
}

/**
 * Inline styling: `code`, **bold**, *italic*.
 * 行内样式：`代码`、**粗体**、*斜体*。
 */
// 本函数：处理行内样式（代码、粗体、斜体）。
function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_, code: string) => chalk.yellow(code))
    .replace(/\*\*([^*]+)\*\*/g, (_, bold: string) => chalk.bold(bold))
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, em: string) => chalk.italic(em))
}

// 本组件：把 Markdown 字符串包进单个 Ink <Text> 渲染。
export function Markdown({ children }: { children: string }): React.ReactElement {
  return <Text>{renderMarkdown(children)}</Text>
}
