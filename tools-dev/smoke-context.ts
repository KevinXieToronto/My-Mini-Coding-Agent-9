// 本文件：上下文层的冒烟脚本，无需模型即可查看指令文件发现、@ 展开与系统提示词拼装的结果。
import {
  buildSessionContext,
  expandUserMentions,
  findInstructionFiles,
  loadProjectInstructions,
} from '../src/context.js'
import { getSystemPrompt } from '../src/constants/prompts.js'
import { getAllTools } from '../src/tools.js'
import { resolve } from 'node:path'

const demo = resolve('demo/sub')

console.log('--- instruction files found (general -> specific) ---')
for (const file of findInstructionFiles(demo)) console.log(`  ${file}`)

console.log('\n--- merged instructions (note the @import was inlined) ---')
console.log(loadProjectInstructions(demo))

console.log('\n--- @mention expansion ---')
console.log(expandUserMentions('what does @demo/shared-rules.md say?', process.cwd()))

console.log('\n--- assembled system prompt ---')
const prompt = getSystemPrompt(getAllTools(), buildSessionContext(process.cwd()))
console.log(prompt)
console.log(`\n--- prompt size: ${prompt.length} chars ---`)
