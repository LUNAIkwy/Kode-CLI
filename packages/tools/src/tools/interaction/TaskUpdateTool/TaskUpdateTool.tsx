import { z } from 'zod'
import type { Tool, ToolUseContext } from '#core/tooling/Tool'
import { emitReminderEvent } from '#core/services/systemReminder'
import {
  addDependency,
  deleteTask,
  getTask,
  getUnmetBlockers,
  listTasks,
  updateTask,
} from '#core/utils/taskStorage'
import type { Task, TaskStatus, TaskUpdate } from '#core/utils/taskStorage'
import { DESCRIPTION, PROMPT } from './prompt'

const statusSchema = z.enum(['pending', 'in_progress', 'completed'])
const statusWithDeletedSchema = statusSchema.or(z.literal('deleted'))

const inputSchema = z.strictObject({
  taskId: z.string().min(1).describe('The ID of the task to update'),
  subject: z.string().optional().describe('New subject for the task'),
  description: z.string().optional().describe('New description for the task'),
  activeForm: z
    .string()
    .optional()
    .describe('Present continuous form shown while in_progress'),
  status: statusWithDeletedSchema
    .optional()
    .describe('New status for the task'),
  addBlocks: z
    .array(z.string())
    .optional()
    .describe('Task IDs that this task blocks'),
  addBlockedBy: z
    .array(z.string())
    .optional()
    .describe('Task IDs that block this task'),
  owner: z.string().optional().describe('New owner for the task'),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Metadata keys to merge into the task. Set a key to null to delete it.',
    ),
})

type Input = z.infer<typeof inputSchema>
type Output =
  | {
      success: true
      taskId: string
      updatedFields: string[]
      statusChange?: { from: TaskStatus; to: TaskStatus | 'deleted' }
      warnings?: string[]
    }
  | {
      success: false
      taskId: string
      updatedFields: string[]
      error: string
      statusChange?: { from: TaskStatus; to: TaskStatus | 'deleted' }
    }

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
}

function formatStatusForDisplay(status: TaskStatus | 'deleted'): string {
  if (status === 'in_progress') return 'in progress'
  return status
}

export const TaskUpdateTool = {
  name: 'TaskUpdate',
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  inputSchema,
  userFacingName() {
    return ''
  },
  async isEnabled() {
    return true
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return true
  },
  needsPermissions() {
    return false
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage(output: Output) {
    if (output.success === false) {
      return `✖ Task #${output.taskId} update failed: ${output.error}`
    }

    if (output.statusChange) {
      return `✔ Task #${output.taskId} updated: status → ${formatStatusForDisplay(output.statusChange.to)}`
    }
    return `✔ Task #${output.taskId} updated`
  },
  renderResultForAssistant(output: Output) {
    if (output.success === false) return output.error
    const fields =
      output.updatedFields.length > 0 ? output.updatedFields.join(', ') : 'ok'
    const warnings =
      output.warnings && output.warnings.length > 0
        ? `\nRejected dependencies: ${output.warnings.join('; ')}`
        : ''
    return `Updated task #${output.taskId} (${fields})${warnings}`
  },
  async *call(input: Input, context?: ToolUseContext) {
    const taskId = input.taskId.trim()
    const existing = getTask(taskId)
    if (!existing) {
      const output: Output = {
        success: false,
        taskId,
        updatedFields: [],
        error: 'Task not found',
      }
      yield {
        type: 'result',
        data: output,
        resultForAssistant: this.renderResultForAssistant(output),
      }
      return
    }

    const updatedFields: string[] = []
    const update: TaskUpdate = {}

    if (
      typeof input.subject === 'string' &&
      input.subject.trim() &&
      input.subject.trim() !== existing.subject
    ) {
      update.subject = input.subject.trim()
      updatedFields.push('subject')
    }
    if (
      typeof input.description === 'string' &&
      input.description.trim() &&
      input.description.trim() !== existing.description
    ) {
      update.description = input.description.trim()
      updatedFields.push('description')
    }
    if (
      typeof input.activeForm === 'string' &&
      input.activeForm.trim() !== (existing.activeForm ?? '')
    ) {
      const next = input.activeForm.trim()
      if (next) {
        update.activeForm = next
      } else {
        // Treat empty string as a clear.
        update.activeForm = undefined
      }
      updatedFields.push('activeForm')
    }
    if (
      typeof input.owner === 'string' &&
      input.owner.trim() !== (existing.owner ?? '')
    ) {
      const next = input.owner.trim()
      update.owner = next ? next : undefined
      updatedFields.push('owner')
    }

    const statusChange =
      input.status && input.status !== existing.status
        ? { from: existing.status, to: input.status }
        : undefined

    if (input.status === 'deleted') {
      const deleted = deleteTask({ taskId })
      let output: Output
      if (!('error' in deleted)) {
        output = {
          success: true,
          taskId,
          updatedFields: ['deleted'],
          statusChange: { from: existing.status, to: 'deleted' },
        }
      } else {
        output = {
          success: false,
          taskId,
          updatedFields: [],
          error: deleted.error,
          statusChange: { from: existing.status, to: 'deleted' },
        }
      }
      if (output.success === true) {
        emitReminderEvent('task:changed', {
          agentId: context?.agentId,
          timestamp: Date.now(),
        })
      }
      yield {
        type: 'result',
        data: output,
        resultForAssistant: this.renderResultForAssistant(output),
      }
      return
    }

    // Dependency order is advisory everywhere else, but starting blocked work
    // breaks the ordering the user asked for. Reject the transition and let the
    // model pick a task whose blockers are done. Blockers added in this same
    // call count too, so one request cannot both start a task and block it.
    if (input.status === 'in_progress' && existing.status !== 'in_progress') {
      const addedBlockers = (input.addBlockedBy ?? [])
        .map(id => String(id).trim())
        .filter(id => id && id !== taskId)
      const prospect: Task =
        addedBlockers.length > 0
          ? {
              ...existing,
              blockedBy: [...existing.blockedBy, ...addedBlockers],
            }
          : existing
      const blockers = getUnmetBlockers(prospect, listTasks())
      if (blockers.length > 0) {
        const output: Output = {
          success: false,
          taskId,
          updatedFields: [],
          error: `Task #${taskId} is blocked by ${blockers
            .map(id => `#${id}`)
            .join(', ')}. Complete or remove those dependencies first.`,
          ...(statusChange ? { statusChange } : {}),
        }
        yield {
          type: 'result',
          data: output,
          resultForAssistant: this.renderResultForAssistant(output),
        }
        return
      }
    }

    if (isTaskStatus(input.status) && input.status !== existing.status) {
      update.status = input.status
      updatedFields.push('status')
    }

    if (input.metadata) {
      const next = { ...(existing.metadata ?? {}) }
      for (const [k, v] of Object.entries(input.metadata)) {
        if (v === null) delete next[k]
        else next[k] = v
      }
      update.metadata = next
      updatedFields.push('metadata')
    }

    const updateResult =
      Object.keys(update).length > 0
        ? updateTask({ taskId, update })
        : ({ ok: true, updated: existing } as const)

    if (updateResult.ok === false) {
      const output: Output = {
        success: false,
        taskId,
        updatedFields: [],
        error: updateResult.error,
        ...(statusChange ? { statusChange } : {}),
      }
      yield {
        type: 'result',
        data: output,
        resultForAssistant: this.renderResultForAssistant(output),
      }
      return
    }

    // Dependencies (best-effort)
    const dependencyErrors: string[] = []
    if (Array.isArray(input.addBlocks) && input.addBlocks.length > 0) {
      for (const other of input.addBlocks) {
        if (!other || other === taskId) continue
        const res = addDependency({ taskId, blocksTaskId: String(other) })
        if ('error' in res) {
          dependencyErrors.push(`blocks #${other} (${res.error})`)
        } else {
          updatedFields.push('blocks')
        }
      }
    }
    if (Array.isArray(input.addBlockedBy) && input.addBlockedBy.length > 0) {
      for (const blocker of input.addBlockedBy) {
        if (!blocker || blocker === taskId) continue
        const res = addDependency({
          taskId: String(blocker),
          blocksTaskId: taskId,
        })
        if ('error' in res) {
          dependencyErrors.push(`blockedBy #${blocker} (${res.error})`)
        } else {
          updatedFields.push('blockedBy')
        }
      }
    }

    const output: Output = {
      success: true,
      taskId,
      updatedFields: Array.from(new Set(updatedFields)),
      ...(statusChange ? { statusChange } : {}),
      ...(dependencyErrors.length > 0 ? { warnings: dependencyErrors } : {}),
    }
    emitReminderEvent('task:changed', {
      agentId: context?.agentId,
      timestamp: Date.now(),
    })
    yield {
      type: 'result',
      data: output,
      resultForAssistant: this.renderResultForAssistant(output),
    }
  },
} satisfies Tool<typeof inputSchema, Output>
