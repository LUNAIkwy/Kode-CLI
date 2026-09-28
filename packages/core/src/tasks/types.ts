export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = {
  id: string
  subject: string
  description: string
  activeForm?: string
  status: TaskStatus
  owner?: string
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
}

export type TaskSummary = {
  id: string
  subject: string
  status: TaskStatus
  owner?: string
  blockedBy: string[]
}

export type TaskUpdate = Partial<
  Pick<
    Task,
    'subject' | 'description' | 'activeForm' | 'status' | 'owner' | 'metadata'
  >
>

/**
 * Derived view of the task dependency graph. Nothing here is persisted: every
 * field is recomputed from the stored tasks, so a completed blocker unlocks its
 * dependents without any write-back.
 */
export type TaskGraphStatus = {
  /** Pending tasks with no unmet blocker, in storage order. */
  ready: string[]
  /** Pending tasks that still have at least one incomplete blocker. */
  blocked: string[]
  /** Tasks currently being worked on. */
  inProgress: string[]
  /** Tasks that are done. */
  completed: string[]
  /** Detected dependency cycles, each listed as task IDs in cycle order. */
  cycles: string[][]
  /** No task is running, pending work remains, and nothing can start. */
  deadlocked: boolean
}
