// 本文件：斜杠命令的类型定义——本地命令（local）与提示词命令（prompt）两种变体及其上下文。
import type { Settings } from '../utils/config.js'
import type { Message } from './message.js'
import type { AppState } from '../state/appState.js'

/**
 * A slash command.
 * 一条斜杠命令。
 *
 * Two variants under one union, and the split is the whole design:
 * 联合类型下的两种变体，这个划分就是全部设计：
 *
 *   'local'   runs code and prints a result. /context, /cost, /clear.
 *             The model never sees it happened.
 *   'local'   执行代码并打印结果（/context、/cost、/clear），模型不知情。
 *   'prompt'  expands into text that is sent to the model AS IF the user had
 *             typed it. /review, /commit, and every custom command.
 *   'prompt'  展开为文本发给模型，就像用户亲手输入（/review、/commit 及所有自定义命令）。
 *
 * That second kind is why users can add commands by dropping a markdown file
 * in a folder: a prompt command is just a template.
 * 正因第二种存在，用户丢一个 markdown 文件就能新增命令：提示词命令不过是模板。
 *
 * cf. src/types/command.ts in the Claude Code tree, which has a third variant
 * ('local-jsx') for commands that render an interactive dialog.
 * 参见 Claude Code 的 src/types/command.ts：那里还有第三种 'local-jsx'，用于渲染交互对话框。
 */

export type CommandContext = {
  settings: Settings
  cwd: string
  messages: Message[]
  systemPrompt: string
  appState: AppState
  /** Replace the conversation, e.g. /clear and /compact. */
  /** 替换整段对话，如 /clear 与 /compact。 */
  setMessages: (messages: Message[]) => void
  /** Print a notice into the transcript. */
  /** 向对话记录里打印一条提示。 */
  notify: (text: string) => void
}

export type LocalCommandResult =
  | { type: 'text'; text: string }
  | { type: 'handled' }
  | { type: 'exit' }

export type CommandBase = {
  name: string
  description: string
  aliases?: string[]
  /** Shown in /help. Hidden commands still work. */
  /** 是否在 /help 中显示；隐藏命令依然可用。 */
  hidden?: boolean
}

export type LocalCommand = CommandBase & {
  type: 'local'
  call: (args: string, ctx: CommandContext) => Promise<LocalCommandResult>
}

export type PromptCommand = CommandBase & {
  type: 'prompt'
  /** Where it came from, for /help and for debugging name collisions. */
  /** 来源，用于 /help 展示与排查重名。 */
  source: 'builtin' | 'project' | 'user'
  /** Shown in the input hint, e.g. "<file path>". */
  /** 输入提示里显示的参数说明，如 "<file path>"。 */
  argumentHint?: string
  getPrompt: (args: string, ctx: CommandContext) => Promise<string>
}

export type Command = LocalCommand | PromptCommand
