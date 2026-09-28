import { z } from 'zod'
import type { Tool } from '#core/tooling/Tool'
import { getTaskGraph, listTaskSummaries } from '#core/utils/taskStorage'
import type { TaskGraphStatus, TaskSummary } from '#core/utils/taskStorage'
import { DESCRIPTION, PROMPT } from './prompt'

const inputSchema = z.strictObject({})

type Output = { tasks: TaskSummary[]; graph: TaskGraphStatus }

export const TaskListTool = {
  name: 'TaskList',
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
    return true
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
  renderToolResultMessage() {
    return null
  },
  renderResultForAssistant(output: Output) {
    const { graph } = output
    const lines =
      output.tasks.length === 0
        ? ['No tasks found']
        : output.tasks.map(t => {
            const owner = t.owner ? ` (${t.owner})` : ''
            const blocked =
              t.blockedBy.length > 0
                ? ` [blocked by ${t.blockedBy.map(id => `#${id}`).join(', ')}]`
                : ''
            return `#${t.id} [${t.status}] ${t.subject}${owner}${blocked}`
          })

    for (const cycle of graph.cycles) {
      lines.push(
        `Dependency cycle: ${cycle.map(id => `#${id}`).join(' -> ')}. These tasks can never become ready.`,
      )
    }
    if (graph.ready.length > 0) {
      lines.push(`Ready now: ${graph.ready.map(id => `#${id}`).join(', ')}`)
    }
    if (graph.deadlocked) {
      lines.push(
        'Deadlock: no task is ready and none is in progress. Remove a dependency or break a cycle to continue.',
      )
    }

    return lines.join('\n')
  },
  async *call() {
    const tasks = listTaskSummaries()
    const output: Output = { tasks, graph: getTaskGraph() }
    yield {
      type: 'result',
      data: output,
      resultForAssistant: this.renderResultForAssistant(output),
    }
  },
} satisfies Tool<typeof inputSchema, Output>
