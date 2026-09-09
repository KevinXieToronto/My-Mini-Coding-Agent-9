// 本文件：上下文压缩与 token 记账的冒烟脚本，验证窗口查询、裁剪、摘要与费用估算。
/**
 * Exercise token accounting and compaction.
 * 演练 token 记账与上下文压缩。
 *
 * The snip and cost paths need no model; the summary path does — point
 * OPENAI_BASE_URL at the stub server if you have no credits.
 * 裁剪与费用路径不需要模型；摘要路径需要——没有额度时把 OPENAI_BASE_URL 指向 stub 服务器。
 */
import type { Message } from '../src/types/message.js'
import {
  CostTracker,
  compactThreshold,
  contextWindowFor,
  estimateConversationTokens,
  tokenState,
} from '../src/utils/tokens.js'
import { compactConversation, snipOldToolResults } from '../src/services/compact/compact.js'
import { loadSettings } from '../src/utils/config.js'

console.log('--- context windows ---')
for (const model of ['gpt-4.1-mini', 'gpt-4o', 'gpt-4', 'qwen2.5-coder:14b', 'something-unknown']) {
  console.log(
    `  ${model.padEnd(20)} window=${contextWindowFor(model).toLocaleString().padStart(9)}  compact at ${compactThreshold(model).toLocaleString()}`,
  )
}

// A conversation dominated by big tool results.
// 一段被大体积工具结果主导的会话。
const messages: Message[] = []
for (let turn = 0; turn < 12; turn++) {
  messages.push({ role: 'user', content: `question number ${turn}` })
  messages.push({
    role: 'assistant',
    content: '',
    toolCalls: [{ id: `c${turn}`, name: 'Grep', arguments: '{"pattern":"x"}' }],
  })
  messages.push({ role: 'tool', toolCallId: `c${turn}`, content: `match line\n`.repeat(400) })
  messages.push({ role: 'assistant', content: `answer number ${turn}` })
}

console.log('\n--- before ---')
console.log('  messages:', messages.length)
console.log('  tokens  : ~' + estimateConversationTokens(messages))

console.log('\n--- snip only (no model call) ---')
const snipped = snipOldToolResults(messages)
console.log('  tokens  : ~' + estimateConversationTokens(snipped))
console.log(
  '  last tool result untouched:',
  snipped.at(-2)!.content.length === messages.at(-2)!.content.length,
)

console.log('\n--- token state at an 8k window ---')
console.log(' ', tokenState(messages, 'system prompt here', 'gpt-4'))

const settings = loadSettings(process.cwd())
settings.model = 'gpt-4'

console.log('\n--- full compaction ---')
const result = await compactConversation(messages, settings)
console.log('  method  :', result.method)
console.log('  tokens  : ~' + result.tokensBefore + ' -> ~' + result.tokensAfter)
console.log('  no orphan tool message at the head:', result.messages[1]?.role !== 'tool')

console.log('\n--- cost tracker ---')
const cost = new CostTracker()
cost.record({ promptTokens: 120_000, completionTokens: 8_000 })
cost.record({ promptTokens: 130_000, completionTokens: 4_000 })
console.log('  gpt-4.1-mini: $' + cost.estimateCost('gpt-4.1-mini')?.toFixed(4))
console.log('  unknown model:', cost.estimateCost('mystery-model'))

console.log('\n--- summary path: long prose, so snipping cannot help ---')
const prose: Message[] = []
for (let turn = 0; turn < 12; turn++) {
  prose.push({ role: 'user', content: `please explain topic ${turn}. `.repeat(60) })
  prose.push({ role: 'assistant', content: `here is a long explanation of topic ${turn}. `.repeat(60) })
}
console.log('  before  : ~' + estimateConversationTokens(prose), 'tokens,', prose.length, 'messages')
const summarised = await compactConversation(prose, settings)
console.log('  method  :', summarised.method)
console.log('  after   : ~' + summarised.tokensAfter, 'tokens,', summarised.messages.length, 'messages')
