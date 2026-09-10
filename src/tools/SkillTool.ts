// 本文件：Skill 工具——在模型判定某技能相关时，把该技能的正文按需加载进对话。
import { z } from 'zod'
import { buildTool } from '../Tool.js'
import type { Skill } from '../skills/loadSkills.js'

/**
 * Invoke a skill: load its body into the conversation.
 * 调用技能：把它的正文加载进对话。
 *
 * The tool is trivial — it returns text from a file. The design is in WHEN
 * that text arrives: not in the system prompt, but at the moment the model
 * decides it is relevant. Everything before this point was about keeping the
 * body out of context; this is the controlled way to let it in.
 * 工具本身很简单——不过是把文件里的文本返回。设计的精髓在于这段文本「何时」到达：
 * 不在系统提示词里，而在模型判定它相关的那一刻。此前的一切都在把正文挡在上下文之外，
 * 这里则是让它进来的那道受控闸门。
 *
 * cf. src/tools/SkillTool/SkillTool.ts.
 * 参见 src/tools/SkillTool/SkillTool.ts。
 */
// 本函数：构造 Skill 工具；技能列表以取值函数注入，便于会话期内替换而不重建工具。
export function createSkillTool(getSkills: () => Skill[]) {
  const schema = z.strictObject({
    skill: z.string().describe('Exact skill name from the Skills list. Do not guess names.'),
    args: z.string().optional().describe('Optional arguments to pass through to the skill.'),
  })

  return buildTool({
    name: 'Skill',
    description:
      'Load a skill: a packaged set of instructions for a particular kind of task. ' +
      'When the task matches a skill listed in your system prompt, call this FIRST — ' +
      'the skill replaces your default approach for that work. Only names from that ' +
      'list are valid.',
    inputSchema: schema,

    // It reads a local file that the user themselves wrote. No approval needed.
    // 它读的是用户自己写的本地文件，无需授权。
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkPermissions: () => ({ behavior: 'allow' }),

    renderCall: input => `Skill(${input.skill})`,
    renderResult: result => {
      const data = result.data as { tokens: number } | undefined
      return data ? `loaded (~${data.tokens} tokens)` : 'loaded'
    },

    validateInput(input) {
      const names = getSkills().map(skill => skill.name)
      if (!names.includes(input.skill)) {
        return {
          ok: false,
          message: `No skill named "${input.skill}". Available: ${names.join(', ') || '(none)'}`,
        }
      }
      return { ok: true }
    },

    async execute(input) {
      const skill = getSkills().find(candidate => candidate.name === input.skill)!
      const header = `# Skill: ${skill.name}`
      const argsLine = input.args ? `\nArguments: ${input.args}` : ''
      const toolsLine = skill.allowedTools?.length
        ? `\nThis skill expects to use: ${skill.allowedTools.join(', ')}`
        : ''

      return {
        result: `${header}${argsLine}${toolsLine}\n\n${skill.body}`,
        data: { tokens: Math.ceil(skill.body.length / 4) },
      }
    },
  })
}
