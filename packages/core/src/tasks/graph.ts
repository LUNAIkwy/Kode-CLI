import type { Task, TaskGraphStatus } from './types'

function indexTasksById(tasks: Task[]): Map<string, Task> {
  const byId = new Map<string, Task>()
  for (const task of tasks) byId.set(task.id, task)
  return byId
}

function normalizeId(id: string): string {
  return id.trim()
}

function unmetBlockersFor(task: Task, byId: Map<string, Task>): string[] {
  return task.blockedBy.map(normalizeId).filter(id => {
    const blocker = byId.get(id)
    // Mirrors listTaskSummaries: a blocker that no longer exists is ignored so
    // a dangling edge never wedges a task permanently.
    if (!blocker) return false
    return blocker.status !== 'completed'
  })
}

export function getUnmetBlockers(task: Task, tasks: Task[]): string[] {
  return unmetBlockersFor(task, indexTasksById(tasks))
}

export function findTaskCycles(tasks: Task[]): string[][] {
  const byId = indexTasksById(tasks)
  type Color = 'white' | 'gray' | 'black'
  const color = new Map<string, Color>()
  for (const task of tasks) color.set(task.id, 'white')

  const stack: string[] = []
  const cycles: string[][] = []
  const seen = new Set<string>()

  const record = (cycle: string[]): void => {
    const key = [...cycle].sort().join('\u0000')
    if (seen.has(key)) return
    seen.add(key)
    cycles.push(cycle)
  }

  const visit = (id: string): void => {
    color.set(id, 'gray')
    stack.push(id)

    const task = byId.get(id)
    for (const raw of task?.blocks ?? []) {
      const next = normalizeId(raw)
      if (!byId.has(next)) continue
      if (next === id) {
        // A task that blocks itself can never become ready.
        record([id])
        continue
      }

      const state = color.get(next)
      if (state === 'gray') {
        const start = stack.indexOf(next)
        if (start !== -1) record(stack.slice(start))
        continue
      }
      if (state === 'white') visit(next)
    }

    stack.pop()
    color.set(id, 'black')
  }

  for (const task of tasks) {
    if (color.get(task.id) === 'white') visit(task.id)
  }

  return cycles
}

export function getTaskGraphStatus(tasks: Task[]): TaskGraphStatus {
  const byId = indexTasksById(tasks)
  const ready: string[] = []
  const blocked: string[] = []
  const inProgress: string[] = []
  const completed: string[] = []

  for (const task of tasks) {
    if (task.status === 'completed') {
      completed.push(task.id)
      continue
    }
    if (task.status === 'in_progress') {
      inProgress.push(task.id)
      continue
    }

    if (unmetBlockersFor(task, byId).length > 0) blocked.push(task.id)
    else ready.push(task.id)
  }

  return {
    ready,
    blocked,
    inProgress,
    completed,
    cycles: findTaskCycles(tasks),
    // Nothing running, work left to do, nothing startable: the graph is stuck.
    deadlocked:
      inProgress.length === 0 &&
      ready.length + blocked.length > 0 &&
      ready.length === 0,
  }
}

export function wouldCreateTaskCycle(args: {
  tasks: Task[]
  taskId: string
  blocksTaskId: string
}): boolean {
  const source = normalizeId(args.taskId)
  const target = normalizeId(args.blocksTaskId)
  if (source === target) return true

  const byId = indexTasksById(args.tasks)
  const seen = new Set<string>()
  const stack = [target]

  // Adding source -> target closes a cycle only when target already blocks
  // source, directly or transitively.
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (current === source) return true
    if (seen.has(current)) continue
    seen.add(current)

    const task = byId.get(current)
    for (const raw of task?.blocks ?? []) {
      const next = normalizeId(raw)
      if (byId.has(next)) stack.push(next)
    }
  }

  return false
}
