// 本文件：内置斜杠命令集合——/help /clear /context /cost /compact /model /mode /sessions /rewind /review /exit。
import type { Command } from '../types/command.js'
import type { Message } from '../types/message.js'
import { PERMISSION_MODES, type PermissionMode } from '../types/permissions.js'
import { CostTracker, tokenState } from '../utils/tokens.js'
import { compactConversation } from '../services/compact/compact.js'
import { listSessions } from '../utils/sessionStorage.js'
import { saveUserSettings } from '../utils/config.js'
import type { FileHistory } from '../utils/fileHistory.js'
import { doctor } from './doctor.js'

/**
 * `/help` lists the registry, which is built from this file — so importing
 * `getCommands` at the top would be a cycle. A dynamic import inside the call
 * breaks it: by the time anyone types /help, both modules are fully loaded.
 * `/help` 要列出注册表，而注册表由本文件构建——顶层 import 会形成循环依赖。
 * 把 import 放进 call 里即可打破：等到用户敲 /help 时，两个模块都已加载完毕。
 */
// 本命令：/help，列出注册表中所有未隐藏的命令，按名排序并对齐成表。
const help: Command = {
  type: 'local',
  name: 'help',
  description: 'List the available commands',
  aliases: ['?'],
  async call(_args, ctx) {
    const { getCommands } = await import('../commands.js')
    const commands = getCommands(ctx.cwd).filter(command => !command.hidden)
    const width = Math.max(...commands.map(command => command.name.length)) + 2  // 以最长命令名 + 2 作为对齐宽度，描述列才会排成一条竖线
    const lines = commands
      .slice()  // 先复制再排序：sort 会就地重排，直接排会打乱注册表本身的顺序
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(command => {
        const hint = command.type === 'prompt' && command.argumentHint
          ? ` ${command.argumentHint}`
          : ''
        const origin = command.type === 'prompt' && command.source !== 'builtin'
          ? `  (${command.source})`
          : ''
        return `  /${(command.name + hint).padEnd(width)} ${command.description}${origin}`
      })
    return { type: 'text', text: ['Commands:', ...lines].join('\n') }
  },
}

// 本命令：清空对话历史。
const clear: Command = {
  type: 'local',
  name: 'clear',
  description: 'Clear the conversation history',
  async call(_args, ctx) {
    ctx.setMessages([])
    return { type: 'text', text: 'Conversation cleared.' }
  },
}

// 本命令：显示上下文窗口占用情况。
const context: Command = {
  type: 'local',
  name: 'context',
  description: 'Show context window usage',
  async call(_args, ctx) {
    const state = tokenState(ctx.messages, ctx.systemPrompt, ctx.settings.model)
    const bar = '='.repeat(Math.round(state.percentUsed / 5)).padEnd(20, '.')  // 百分比除以 5 即映射到 20 格进度条，再用点号补齐余下的格子
    return {
      type: 'text',
      text: [
        `context:   [${bar}] ${state.percentUsed}%`,
        `estimated: ~${state.used.toLocaleString()} / ${state.window.toLocaleString()} tokens`,
        `compact at:~${state.threshold.toLocaleString()} tokens`,
        `messages:  ${ctx.messages.length}`,
      ].join('\n'),
    }
  },
}

/**
 * Commands that need state the REPL owns (the cost tracker, the file history)
 * are built by a factory rather than declared as a constant. Same contract,
 * just a closure — no special case in the dispatcher.
 * 需要 REPL 持有的状态（花费统计、文件历史）的命令用工厂构建，而非声明为常量。
 * 契约相同，只是多了个闭包——分发器里不需要任何特例。
 */
// 本函数：构建 /cost 命令，闭包持有 REPL 的花费统计器，报告用量与估算金额。
export function makeCostCommand(cost: CostTracker): Command {
  return {
    type: 'local',
    name: 'cost',
    description: 'Show token usage and estimated cost',
    async call(_args, ctx) {
      const dollars = cost.estimateCost(ctx.settings.model)
      return {
        type: 'text',
        text: [
          `requests:  ${cost.requests}`,
          `input:     ${cost.promptTokens.toLocaleString()} tokens`,
          `output:    ${cost.completionTokens.toLocaleString()} tokens`,
          `cost:      ${dollars === undefined ? 'unknown (no pricing for this model)' : `$${dollars.toFixed(4)}`}`,
        ].join('\n'),
      }
    },
  }
}

// 本函数：构建 /rewind 命令，闭包持有 REPL 的文件历史，回退消息并还原文件。
export function makeRewindCommand(fileHistory: FileHistory): Command {
  return {
    type: 'local',
    name: 'rewind',
    description: 'Undo the last N turns, restoring changed files',
    async call(args, ctx) {
      const turns = Number(args || '1')
      const target = rewindTarget(ctx.messages, Number.isFinite(turns) ? turns : 1)
      const files = fileHistory.rewindTo(target)  // 先还原文件再截断消息：只退消息不退文件，会得到与工作区矛盾的对话
      ctx.setMessages(ctx.messages.slice(0, target))
      return {
        type: 'text',
        text:
          `Rewound to message ${target}` +
          (files.length ? `; restored ${files.length} file(s).` : '.'),
      }
    },
  }
}

/**
 * Index to truncate to, counting back `turns` USER messages.
 * We rewind to before a user message, because that is the unit a human thinks
 * in — "undo what you did after I asked for X".
 * 往回数 `turns` 条用户消息得到截断下标。回退到某条用户消息之前，
 * 因为这才是人类思考的单位——「把我说了 X 之后你做的都撤掉」。
 */
// 本函数：计算回退目标下标，按用户消息倒数 turns 条。
export function rewindTarget(messages: Message[], turns: number): number {
  const userIndexes = messages
    .map((message, index) => (message.role === 'user' ? index : -1))
    .filter(index => index >= 0)
  const target = userIndexes[userIndexes.length - turns]  // 倒数第 turns 条用户消息的下标即截断点；越界时下一行退回 0，即回到开头
  return target ?? 0
}

// 本命令：手动压缩对话历史，腾出上下文窗口。
const compact: Command = {
  type: 'local',
  name: 'compact',
  description: 'Summarise the conversation to free context',
  async call(_args, ctx) {
    const result = await compactConversation(ctx.messages, ctx.settings)
    ctx.setMessages(result.messages)
    return {
      type: 'text',
      text: `Compacted via ${result.method}: ~${result.tokensBefore} -> ~${result.tokensAfter} tokens.`,
    }
  },
}

// 本命令：查看或切换模型；带 --save 时写回用户级设置。
const model: Command = {
  type: 'local',
  name: 'model',
  description: 'Show or change the model (append --save to persist)',
  async call(args, ctx) {
    if (!args) return { type: 'text', text: `Current model: ${ctx.settings.model}` }
    const save = /(^|\s)--save(\s|$)/.test(args)
    const name = args.replace(/(^|\s)--save(\s|$)/, ' ').trim()  // 把 --save 从参数里剔掉，余下的才是模型名；两侧的空白捕获用于避免粘连
    if (!name) return { type: 'text', text: `Current model: ${ctx.settings.model}` }
    ctx.settings.model = name
    // Persisting is opt-in: a one-off experiment should not rewrite settings.
    // 持久化需显式声明：一次性试验不该改写用户设置。
    if (save) saveUserSettings({ model: name })
    return { type: 'text', text: `Model set to ${name}${save ? ' and saved.' : '.'}` }
  },
}

// 本命令：查看或切换权限模式。
const mode: Command = {
  type: 'local',
  name: 'mode',
  description: 'Show or change the permission mode',
  async call(args, ctx) {
    if (!args) {
      return {
        type: 'text',
        text: `Current mode: ${ctx.settings.permissionMode}\nAvailable: ${PERMISSION_MODES.join(', ')}`,
      }
    }
    if (!(PERMISSION_MODES as string[]).includes(args)) {
      return { type: 'text', text: `Unknown mode "${args}". Valid: ${PERMISSION_MODES.join(', ')}` }
    }
    ctx.settings.permissionMode = args as PermissionMode
    return {
      type: 'text',
      text:
        `Mode set to ${args}.` +
        (args === 'bypassPermissions' ? ' All guard rails except deny rules are off.' : ''),
    }
  },
}

// 本命令：列出当前项目的历史会话记录。
const sessions: Command = {
  type: 'local',
  name: 'sessions',
  description: 'List saved sessions for this project',
  async call(_args, ctx) {
    const list = listSessions(ctx.cwd).slice(0, 10)
    if (list.length === 0) return { type: 'text', text: 'No saved sessions for this project.' }
    const lines = list.map(session => {
      const when = new Date(session.updatedAt).toLocaleString()
      return `  ${session.sessionId.slice(0, 8)}  ${when}  ${session.entryCount} msgs  ${session.preview.slice(0, 40)}`
    })
    return { type: 'text', text: ['Sessions (newest first):', ...lines].join('\n') }
  },
}

/**
 * A built-in PROMPT command: it expands to text and is sent to the model.
 * This is the same mechanism a user gets from dropping a markdown file in
 * .mini-cc/commands — built-ins have no special powers.
 * 一条内置的「提示词命令」：展开成文本发给模型。
 * 这与用户往 .mini-cc/commands 丢 markdown 文件所得到的机制完全相同——内置命令没有特权。
 */
// 本命令：/review，展开成一段代码评审提示词发给模型，与用户自写的 markdown 命令走同一条机制。
const review: Command = {
  type: 'prompt',
  name: 'review',
  description: 'Review uncommitted changes',
  source: 'builtin',
  argumentHint: '[path]',
  async getPrompt(args) {
    return [
      'Review the uncommitted changes in this repository.',
      args ? `Focus on: ${args}` : '',
      '',
      'Run `git diff` (and `git diff --staged`) to see them, then report:',
      '1. Correctness bugs, most severe first.',
      '2. Anything that duplicates existing code in the project.',
      '3. Missing error handling or edge cases.',
      '',
      'Be specific: cite file and line. Do not restate what the code does,',
      'and do not comment on style unless it hides a bug. If the changes look',
      'fine, say so in one sentence.',
    ]
      .filter(Boolean)
      .join('\n')
  },
}

// 本命令：退出 REPL。
const exitCommand: Command = {
  type: 'local',
  name: 'exit',
  description: 'Leave mini-cc',
  aliases: ['quit'],
  async call() {
    return { type: 'exit' }
  },
}

export const BUILTIN_COMMANDS: Command[] = [
  help, clear, context, compact, model, mode, sessions, doctor, review, exitCommand,
]
