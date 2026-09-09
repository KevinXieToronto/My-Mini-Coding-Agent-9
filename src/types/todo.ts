// 本文件：待办事项（Todo）的数据模型与 zod schema，供 TodoWrite 工具和 UI 共用。
import { z } from 'zod'

// 本常量：待办状态枚举——待办 / 进行中 / 已完成。
export const TodoStatusSchema = z.enum(['pending', 'in_progress', 'completed'])

// 本常量：单条待办的 schema；strictObject 拒绝模型多写的字段。
export const TodoSchema = z.strictObject({
  content: z.string().min(1).describe('The task, in imperative form: "Add a health check".'),
  activeForm: z
    .string()
    .min(1)
    .describe('The same task in present continuous form: "Adding a health check".'),
  status: TodoStatusSchema,
})

// 本常量：整张待办清单的 schema。
export const TodoListSchema = z.array(TodoSchema)

export type Todo = z.infer<typeof TodoSchema>
export type TodoStatus = z.infer<typeof TodoStatusSchema>
