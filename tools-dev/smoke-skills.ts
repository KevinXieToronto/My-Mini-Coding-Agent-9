// 本文件：技能的冒烟脚本——不接模型，直接演示技能加载、条件可见性、渐进式披露的成本与调用。
import { loadSkills, renderSkillsSection, visibleSkills } from '../src/skills/loadSkills.js'
import { createSkillTool } from '../src/tools/SkillTool.js'
import { estimateTokens } from '../src/utils/tokens.js'
import { makeContext } from './testContext.js'

const cwd = process.cwd()

console.log('--- loading ---')
const skills = loadSkills(cwd)
for (const skill of skills) {
  console.log(
    `  ${skill.name.padEnd(16)} ${skill.source.padEnd(8)} body=${skill.body.length} chars` +
      (skill.paths ? `  conditional on ${skill.paths.join(', ')}` : ''),
  )
}

console.log('\n--- conditional visibility ---')
console.log(
  '  nothing touched  :',
  visibleSkills(skills, [])
    .map(s => s.name)
    .join(', '),
)
console.log(
  '  touched app.py   :',
  visibleSkills(skills, ['src/app.py'])
    .map(s => s.name)
    .join(', '),
)

console.log('\n--- progressive disclosure: what the prompt actually costs ---')
const section = renderSkillsSection(visibleSkills(skills, []))
console.log(
  section
    .split('\n')
    .map(l => '  ' + l)
    .join('\n'),
)
const bodyTokens = skills.reduce((sum, s) => sum + estimateTokens(s.body), 0)
console.log(`\n  prompt section: ~${estimateTokens(section)} tokens`)
console.log(`  all bodies    : ~${bodyTokens} tokens  (NOT in the prompt)`)

console.log('\n--- invoking a skill ---')
const tool = createSkillTool(() => skills)
const ctx = makeContext({ cwd })
console.log('  unknown name:', tool.validateInput!({ skill: 'nonexistent' }, ctx))
const out = await tool.execute({ skill: 'commit-message', args: 'for the auth change' }, ctx)
console.log('  loaded:', tool.renderResult!(out, { skill: 'commit-message' }))
