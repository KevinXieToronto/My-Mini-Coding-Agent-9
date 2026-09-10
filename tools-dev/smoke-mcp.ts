// 本文件：MCP 的手动冒烟脚本，不经模型直接验证连接、失败记录、工具适配与结果截断。
import { loadMcpConfig } from '../src/services/mcp/config.js'
import {
  connectAll,
  disconnectAll,
  renderMcpInstructions,
} from '../src/services/mcp/client.js'
import { toApiTools } from '../src/Tool.js'
import { makeContext } from './testContext.js'

const cwd = process.cwd()

const servers = loadMcpConfig(cwd)
console.log('configured servers:', Object.keys(servers))

const connections = await connectAll(servers)
for (const connection of connections) {
  console.log(
    `- ${connection.name}: ${connection.error ? `FAILED (${connection.error})` : `${connection.tools.length} tools`}`,
  )
}

const tools = connections.flatMap(connection => connection.tools)
console.log('namespaced names:', tools.map(tool => tool.name))

// The schema the model actually sees comes from the server, untouched by zod.
// 模型真正看到的 schema 直接来自服务器，未经 zod 加工。
const dice = tools.find(tool => tool.name.endsWith('roll_dice'))
if (dice) {
  console.log('roll_dice schema:', JSON.stringify(toApiTools([dice])[0]!.function.parameters))
  console.log('read-only?', dice.isReadOnly?.({}))
  console.log('renderCall:', dice.renderCall?.({ sides: 6, count: 2 }))
  const result = await dice.execute({ sides: 6, count: 2 }, makeContext({ cwd }))
  console.log('result:', result.result, '| data:', result.data)
}

// A tool that reports isError must throw, so query() feeds the text back as a
// tool_result and the model can self-correct.
// 报告 isError 的工具必须抛错，query() 才会把错误文本作为 tool_result 回传，让模型自我纠正。
const broken = tools.find(tool => tool.name.endsWith('always_fails'))
if (broken) {
  try {
    await broken.execute({}, makeContext({ cwd }))
    console.log('always_fails: did NOT throw (wrong)')
  } catch (error) {
    console.log('always_fails threw:', error instanceof Error ? error.message : error)
  }
}

console.log('\n--- instructions section ---')
console.log(renderMcpInstructions(connections) || '(none)')

await disconnectAll(connections)
