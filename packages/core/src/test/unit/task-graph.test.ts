import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addDependency,
  createTask,
  findTaskCycles,
  getTaskGraph,
  getTaskGraphStatus,
  getUnmetBlockers,
  listTasks,
  updateTask,
  wouldCreateTaskCycle,
} from '#core/utils/taskStorage'
import type { Task } from '#core/utils/taskStorage'
import { TaskUpdateTool } from '#tools/tools/interaction/TaskUpdateTool/TaskUpdateTool'

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    subject: `task ${overrides.id}`,
    description: `task ${overrides.id}`,
    status: 'pending',
    blocks: [],
    blockedBy: [],
    ...overrides,
  }
}

async function runTaskUpdate(input: unknown) {
  let data: any = null
  for await (const chunk of TaskUpdateTool.call(input as never)) {
    if (chunk.type === 'result') data = chunk.data
  }
  return data
}

describe('task graph: derived status', () => {
  test('partitions tasks into ready / blocked / in progress / completed', () => {
    const graph = getTaskGraphStatus([
      makeTask({ id: '1', status: 'completed' }),
      makeTask({ id: '2', blockedBy: ['1'] }),
      makeTask({ id: '3' }),
      makeTask({ id: '4', status: 'in_progress' }),
    ])

    expect(graph.completed).toEqual(['1'])
    expect(graph.ready).toEqual(['2', '3'])
    expect(graph.blocked).toEqual([])
    expect(graph.inProgress).toEqual(['4'])
    expect(graph.deadlocked).toBe(false)
  })

  test('keeps a task blocked while its blocker is unfinished', () => {
    const graph = getTaskGraphStatus([
      makeTask({ id: '1' }),
      makeTask({ id: '2', blockedBy: ['1'] }),
    ])

    expect(graph.ready).toEqual(['1'])
    expect(graph.blocked).toEqual(['2'])
    expect(graph.deadlocked).toBe(false)
  })

  test('ignores blockers that no longer exist', () => {
    const tasks = [makeTask({ id: '1', blockedBy: ['999'] })]

    expect(getUnmetBlockers(tasks[0]!, tasks)).toEqual([])
    expect(getTaskGraphStatus(tasks).ready).toEqual(['1'])
  })

  test('reports deadlock when nothing runs and nothing is ready', () => {
    const graph = getTaskGraphStatus([
      makeTask({ id: '1', blocks: ['2'], blockedBy: ['2'] }),
      makeTask({ id: '2', blocks: ['1'], blockedBy: ['1'] }),
    ])

    expect(graph.ready).toEqual([])
    expect(graph.blocked).toEqual(['1', '2'])
    expect(graph.cycles).toEqual([['1', '2']])
    expect(graph.deadlocked).toBe(true)
  })

  test('is not deadlocked while a blocker is still running', () => {
    const graph = getTaskGraphStatus([
      makeTask({ id: '1', status: 'in_progress' }),
      makeTask({ id: '2', blockedBy: ['1'] }),
    ])

    expect(graph.deadlocked).toBe(false)
  })
})

describe('task graph: cycles', () => {
  test('ignores acyclic graphs', () => {
    expect(findTaskCycles([])).toEqual([])
    expect(
      findTaskCycles([
        makeTask({ id: '1', blocks: ['2'] }),
        makeTask({ id: '2' }),
      ]),
    ).toEqual([])
  })

  test('finds a self dependency', () => {
    expect(findTaskCycles([makeTask({ id: '1', blocks: ['1'] })])).toEqual([
      ['1'],
    ])
  })

  test('finds a longer cycle once', () => {
    const cycles = findTaskCycles([
      makeTask({ id: '1', blocks: ['2'] }),
      makeTask({ id: '2', blocks: ['3'] }),
      makeTask({ id: '3', blocks: ['1'] }),
    ])

    expect(cycles).toEqual([['1', '2', '3']])
  })

  test('wouldCreateTaskCycle covers direct, transitive, and self edges', () => {
    const tasks = [
      makeTask({ id: '1', blocks: ['2'] }),
      makeTask({ id: '2', blocks: ['3'] }),
      makeTask({ id: '3' }),
    ]

    expect(
      wouldCreateTaskCycle({ tasks, taskId: '3', blocksTaskId: '1' }),
    ).toBe(true)
    expect(
      wouldCreateTaskCycle({ tasks, taskId: '2', blocksTaskId: '3' }),
    ).toBe(false)
    expect(
      wouldCreateTaskCycle({ tasks, taskId: '1', blocksTaskId: '1' }),
    ).toBe(true)
  })
})

describe('task graph: storage and tool wiring', () => {
  const taskListId = 'task-graph-test'
  const ENV_KEYS = [
    'HOME',
    'KODE_CONFIG_DIR',
    'CLAUDE_CONFIG_DIR',
    'KODE_TASK_LIST_ID',
  ] as const
  const saved: Record<string, string | undefined> = {}
  let tempDirs: string[] = []

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key]

    tempDirs = ['home', 'kode', 'claude'].map(prefix =>
      mkdtempSync(join(tmpdir(), `kode-task-graph-${prefix}-`)),
    )
    const [homeDir, kodeDir, claudeDir] = tempDirs as [string, string, string]
    process.env.HOME = homeDir
    process.env.KODE_CONFIG_DIR = kodeDir
    process.env.CLAUDE_CONFIG_DIR = claudeDir
    process.env.KODE_TASK_LIST_ID = taskListId
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
    tempDirs = []
  })

  test('addDependency rejects an edge that would close a cycle', () => {
    const a = createTask({ subject: 'a', description: 'a' })
    const b = createTask({ subject: 'b', description: 'b' })

    expect(addDependency({ taskId: a.id, blocksTaskId: b.id }).ok).toBe(true)

    const cycle = addDependency({ taskId: b.id, blocksTaskId: a.id })
    expect(cycle.ok).toBe(false)
    if (cycle.ok === false) expect(cycle.error).toContain('cycle')

    const graph = getTaskGraph()
    expect(graph.cycles).toEqual([])
    expect(graph.ready).toEqual([a.id])
    expect(graph.blocked).toEqual([b.id])
  })

  test('addDependency rejects a self dependency', () => {
    const a = createTask({ subject: 'a', description: 'a' })

    const result = addDependency({ taskId: a.id, blocksTaskId: a.id })
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.error).toContain('itself')
  })

  test('ready set advances once the blocker completes', () => {
    const a = createTask({ subject: 'a', description: 'a' })
    const b = createTask({ subject: 'b', description: 'b' })
    addDependency({ taskId: a.id, blocksTaskId: b.id })

    expect(getTaskGraph().ready).toEqual([a.id])

    updateTask({ taskId: a.id, update: { status: 'completed' } })

    expect(getTaskGraph().ready).toEqual([b.id])
    expect(getTaskGraph().blocked).toEqual([])
  })

  test('TaskUpdate refuses to start a blocked task', async () => {
    const a = createTask({ subject: 'a', description: 'a' })
    const b = createTask({ subject: 'b', description: 'b' })
    addDependency({ taskId: a.id, blocksTaskId: b.id })

    const output = await runTaskUpdate({ taskId: b.id, status: 'in_progress' })

    expect(output.success).toBe(false)
    expect(output.error).toContain(`blocked by #${a.id}`)
    expect(listTasks().find(t => t.id === b.id)?.status).toBe('pending')
  })

  test('TaskUpdate refuses to start a task blocked in the same call', async () => {
    const a = createTask({ subject: 'a', description: 'a' })
    const b = createTask({ subject: 'b', description: 'b' })

    const output = await runTaskUpdate({
      taskId: b.id,
      status: 'in_progress',
      addBlockedBy: [a.id],
    })

    expect(output.success).toBe(false)
    expect(output.error).toContain(`blocked by #${a.id}`)
    expect(listTasks().find(t => t.id === b.id)?.status).toBe('pending')
    // A rejected transition must not have written the dependency either.
    expect(listTasks().find(t => t.id === b.id)?.blockedBy).toEqual([])
  })

  test('TaskUpdate allows starting when the same-call blocker is done', async () => {
    const a = createTask({ subject: 'a', description: 'a' })
    const b = createTask({ subject: 'b', description: 'b' })
    updateTask({ taskId: a.id, update: { status: 'completed' } })

    const output = await runTaskUpdate({
      taskId: b.id,
      status: 'in_progress',
      addBlockedBy: [a.id],
    })

    expect(output.success).toBe(true)
    expect(listTasks().find(t => t.id === b.id)?.status).toBe('in_progress')
  })

  test('TaskUpdate still starts an unblocked task', async () => {
    const a = createTask({ subject: 'a', description: 'a' })

    const output = await runTaskUpdate({ taskId: a.id, status: 'in_progress' })

    expect(output.success).toBe(true)
    expect(listTasks().find(t => t.id === a.id)?.status).toBe('in_progress')
  })

  test('TaskUpdate surfaces a rejected dependency instead of dropping it', async () => {
    const a = createTask({ subject: 'a', description: 'a' })
    const b = createTask({ subject: 'b', description: 'b' })
    addDependency({ taskId: a.id, blocksTaskId: b.id })

    const output = await runTaskUpdate({ taskId: b.id, addBlocks: [a.id] })

    expect(output.success).toBe(true)
    expect(output.warnings).toHaveLength(1)
    expect(output.warnings[0]).toContain('cycle')
  })
})
