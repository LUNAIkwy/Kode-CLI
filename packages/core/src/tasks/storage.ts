import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { getKodeRoot, resolveDataRoots } from '#config/dataRoots'
import { LEGACY_ENV } from '#config/compat/legacyEnv'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'
import { getKodeAgentSessionForkInfo } from '#protocol/utils/kodeAgentSessionForkInfo'
import { debug as debugLogger } from '#core/utils/debugLogger'
import { logError } from '#core/utils/log'
import { getTaskGraphStatus, wouldCreateTaskCycle } from './graph'
import type {
  Task,
  TaskGraphStatus,
  TaskStatus,
  TaskSummary,
  TaskUpdate,
} from './types'

const TASKS_DIRNAME = 'tasks'
const TASK_FILE_EXT = '.json'
const HIGH_WATERMARK_FILENAME = '.highwatermark'
const LEGACY_HIGH_WATERMARK_FILENAMES = ['.highwatermark', '.max_id'] as const
const TOMBSTONES_FILENAME = '.tombstones.json'
const LOCK_FILENAME = '.lock'

const LOCK_STALE_MS = 10_000
const LOCK_RETRIES = 5
const LOCK_RETRY_DELAY_MS = 50

function sleepSync(ms: number): void {
  if (ms <= 0) return
  const buf = new SharedArrayBuffer(4)
  const arr = new Int32Array(buf)
  Atomics.wait(arr, 0, 0, ms)
}

function safeMkdir(dirPath: string): void {
  try {
    mkdirSync(dirPath, { recursive: true })
  } catch {
    // best-effort
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // best-effort
  }
}

function acquireFileLock(lockPath: string): (() => void) | null {
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      writeFileSync(lockPath, `${process.pid} ${Date.now()}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      return () => safeUnlink(lockPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code !== 'EEXIST') return null

      try {
        const st = statSync(lockPath)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) safeUnlink(lockPath)
      } catch {
        // ignore
      }

      sleepSync(LOCK_RETRY_DELAY_MS)
    }
  }

  return null
}

function atomicWriteJson(filePath: string, data: unknown): void {
  safeMkdir(dirname(filePath))
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  const content = JSON.stringify(data, null, 2)
  writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(tmpPath, filePath)
  } catch (error) {
    // Windows cannot always rename over an existing destination file.
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    const canFallback = [
      'EPERM',
      'EACCES',
      'EEXIST',
      'ENOTEMPTY',
      'EBUSY',
    ].includes(String(code ?? ''))
    if (!canFallback) {
      safeUnlink(tmpPath)
      throw error
    }

    try {
      writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 })
    } finally {
      safeUnlink(tmpPath)
    }
  }
}

function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function cleanStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter(isNonEmptyString).map(s => s.trim())
}

export function sanitizeTaskListId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export function getTaskListId(): string {
  const raw =
    process.env.KODE_TASK_LIST_ID ??
    process.env[LEGACY_ENV.codeTaskListId] ??
    ''
  const trimmed = raw.trim()
  if (trimmed) return trimmed
  const fork = getKodeAgentSessionForkInfo()
  if (fork?.forkRootSessionId) return fork.forkRootSessionId
  return getKodeAgentSessionId()
}

export function getTaskStoreRoots(): string[] {
  return resolveDataRoots().allRoots
}

function getPrimaryTaskStoreRoot(): string {
  return getKodeRoot()
}

export function getTaskListDir(taskListId: string): string {
  return join(
    getPrimaryTaskStoreRoot(),
    TASKS_DIRNAME,
    sanitizeTaskListId(taskListId),
  )
}

function getTaskListDirCandidatesForRead(taskListId: string): string[] {
  const dirs: string[] = []
  const sanitized = sanitizeTaskListId(taskListId)
  for (const root of getTaskStoreRoots()) {
    dirs.push(join(root, TASKS_DIRNAME, sanitized))
  }
  return dirs
}

function getTaskPath(taskListDir: string, taskId: string): string {
  return join(taskListDir, `${sanitizeTaskListId(taskId)}${TASK_FILE_EXT}`)
}

function readMaxId(taskListDir: string): number {
  for (const name of LEGACY_HIGH_WATERMARK_FILENAMES) {
    try {
      const raw = readFileSync(join(taskListDir, name), 'utf8').trim()
      const parsed = parseInt(raw, 10)
      return Number.isFinite(parsed) ? parsed : 0
    } catch {
      // continue
    }
  }
  return 0
}

function writeMaxId(taskListDir: string, id: number): void {
  try {
    safeMkdir(taskListDir)
    writeFileSync(join(taskListDir, HIGH_WATERMARK_FILENAME), String(id), {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch {
    // best-effort
  }
}

type Tombstones = Record<string, number>

function readTombstones(taskListDir: string): Tombstones {
  try {
    const path = join(taskListDir, TOMBSTONES_FILENAME)
    if (!existsSync(path)) return {}
    const raw = readFileSync(path, 'utf8')
    const parsed = safeParseJson<unknown>(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    const out: Tombstones = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!k) continue
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function writeTombstones(taskListDir: string, tombstones: Tombstones): void {
  atomicWriteJson(join(taskListDir, TOMBSTONES_FILENAME), tombstones)
}

function scanMaxIdFromFiles(taskListDir: string): number {
  try {
    if (!existsSync(taskListDir)) return 0
    let max = 0
    for (const name of readdirSync(taskListDir)) {
      if (!name.endsWith(TASK_FILE_EXT)) continue
      const base = name.slice(0, -TASK_FILE_EXT.length)
      const parsed = parseInt(base, 10)
      if (Number.isFinite(parsed) && parsed > max) max = parsed
    }
    return max
  } catch {
    return 0
  }
}

function getHighestTaskIdForDir(taskListDir: string): number {
  return Math.max(scanMaxIdFromFiles(taskListDir), readMaxId(taskListDir))
}

function getHighestTaskIdAcrossStores(taskListId: string): number {
  const dirs = getTaskListDirCandidatesForRead(taskListId)
  let max = 0
  for (const dir of dirs) {
    max = Math.max(max, getHighestTaskIdForDir(dir))
  }
  return max
}

function getNextTaskId(args: {
  taskListId: string
  taskListDir: string
}): string {
  const maxAcrossStores = getHighestTaskIdAcrossStores(args.taskListId)
  const next = maxAcrossStores + 1
  writeMaxId(args.taskListDir, next)
  return String(next)
}

function loadTaskFromPath(filePath: string): Task | null {
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = safeParseJson<unknown>(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }

    const rec = parsed as Record<string, unknown>

    if (!isNonEmptyString(rec.id)) return null
    if (!isNonEmptyString(rec.subject)) return null
    if (!isNonEmptyString(rec.description)) return null
    if (!isTaskStatus(rec.status)) return null

    const blocks = cleanStringArray(rec.blocks) ?? []
    const blockedBy = cleanStringArray(rec.blockedBy) ?? []

    const out: Task = {
      id: rec.id.trim(),
      subject: rec.subject.trim(),
      description: rec.description.trim(),
      status: rec.status,
      owner: isNonEmptyString(rec.owner) ? rec.owner.trim() : undefined,
      activeForm: isNonEmptyString(rec.activeForm)
        ? rec.activeForm.trim()
        : undefined,
      blocks,
      blockedBy,
      metadata:
        rec.metadata &&
        typeof rec.metadata === 'object' &&
        !Array.isArray(rec.metadata)
          ? (rec.metadata as Record<string, unknown>)
          : undefined,
    }

    return out
  } catch (error) {
    logError(error)
    return null
  }
}

function listTasksFromDir(taskListDir: string): Task[] {
  try {
    if (!existsSync(taskListDir)) return []
    const tasks: Task[] = []
    for (const name of readdirSync(taskListDir)) {
      if (!name.endsWith(TASK_FILE_EXT)) continue
      if (name.startsWith('.')) continue
      const task = loadTaskFromPath(join(taskListDir, name))
      if (task) tasks.push(task)
    }
    return tasks
  } catch (error) {
    logError(error)
    return []
  }
}

function getTaskFromDir(taskListDir: string, taskId: string): Task | null {
  const filePath = getTaskPath(taskListDir, sanitizeTaskListId(taskId))
  if (!existsSync(filePath)) return null
  return loadTaskFromPath(filePath)
}

export function listTasks(taskListId: string = getTaskListId()): Task[] {
  const dirs = getTaskListDirCandidatesForRead(taskListId)
  const primaryDir = getTaskListDir(taskListId)
  const tombstones = readTombstones(primaryDir)

  const tasksById = new Map<string, Task>()
  for (const dir of [...dirs].reverse()) {
    const tasks = listTasksFromDir(dir)
    for (const task of tasks) tasksById.set(task.id, task)
  }

  for (const id of Object.keys(tombstones)) tasksById.delete(id)

  return [...tasksById.values()].sort((a, b) => {
    const aNum = parseInt(a.id, 10)
    const bNum = parseInt(b.id, 10)
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum
    return a.id.localeCompare(b.id)
  })
}

export function listTaskSummaries(
  taskListId: string = getTaskListId(),
): TaskSummary[] {
  const tasks = listTasks(taskListId)
  const taskIds = new Set(tasks.map(t => t.id))
  const completed = new Set(
    tasks.filter(t => t.status === 'completed').map(t => t.id),
  )
  return tasks.map(t => ({
    id: t.id,
    subject: t.subject,
    status: t.status,
    owner: t.owner,
    blockedBy: t.blockedBy.filter(id => taskIds.has(id) && !completed.has(id)),
  }))
}

export function getTaskGraph(
  taskListId: string = getTaskListId(),
): TaskGraphStatus {
  return getTaskGraphStatus(listTasks(taskListId))
}

export function getTask(
  taskId: string,
  taskListId: string = getTaskListId(),
): Task | null {
  const primaryDir = getTaskListDir(taskListId)
  const tombstones = readTombstones(primaryDir)
  if (tombstones[taskId]) return null

  const dirs = getTaskListDirCandidatesForRead(taskListId)
  const sanitized = sanitizeTaskListId(taskId)
  for (const dir of dirs) {
    const filePath = getTaskPath(dir, sanitized)
    if (!existsSync(filePath)) continue
    const task = loadTaskFromPath(filePath)
    if (task) return task
  }
  return null
}

function getTaskFromNonPrimaryStores(args: {
  taskId: string
  taskListId: string
}): Task | null {
  const dirs = getTaskListDirCandidatesForRead(args.taskListId)
  const primaryDir = getTaskListDir(args.taskListId)

  const sanitized = sanitizeTaskListId(args.taskId)
  for (const dir of dirs) {
    if (dir === primaryDir) continue
    const filePath = getTaskPath(dir, sanitized)
    if (!existsSync(filePath)) continue
    const task = loadTaskFromPath(filePath)
    if (task) return task
  }
  return null
}

function ensureTaskAdopted(args: {
  taskId: string
  taskListId: string
  taskListDir: string
}): Task | null {
  const existing = getTaskFromDir(args.taskListDir, args.taskId)
  if (existing) return existing

  const tombstones = readTombstones(args.taskListDir)
  if (tombstones[args.taskId]) return null

  const legacy = getTaskFromNonPrimaryStores({
    taskId: args.taskId,
    taskListId: args.taskListId,
  })
  if (!legacy) return null

  atomicWriteJson(getTaskPath(args.taskListDir, legacy.id), legacy)

  const idNum = parseInt(legacy.id, 10)
  if (Number.isFinite(idNum) && idNum > readMaxId(args.taskListDir)) {
    writeMaxId(args.taskListDir, idNum)
  }

  return legacy
}

export function createTask(args: {
  subject: string
  description: string
  activeForm?: string
  metadata?: Record<string, unknown>
  taskListId?: string
}): { id: string } {
  const taskListId = args.taskListId ?? getTaskListId()
  const dir = getTaskListDir(taskListId)
  safeMkdir(dir)

  const lockPath = join(dir, LOCK_FILENAME)
  const release = acquireFileLock(lockPath)
  if (!release) {
    throw new Error('Failed to acquire task store lock.')
  }

  try {
    const id = getNextTaskId({ taskListId, taskListDir: dir })
    const task: Task = {
      id,
      subject: args.subject,
      description: args.description,
      ...(args.activeForm ? { activeForm: args.activeForm } : {}),
      status: 'pending',
      owner: undefined,
      blocks: [],
      blockedBy: [],
      ...(args.metadata ? { metadata: args.metadata } : {}),
    }
    atomicWriteJson(getTaskPath(dir, id), task)
    return { id }
  } finally {
    release()
  }
}

export function updateTask(args: {
  taskId: string
  update: TaskUpdate
  taskListId?: string
}): { ok: true; updated: Task } | { ok: false; error: string } {
  const taskListId = args.taskListId ?? getTaskListId()
  const dir = getTaskListDir(taskListId)
  safeMkdir(dir)

  const lockPath = join(dir, LOCK_FILENAME)
  const release = acquireFileLock(lockPath)
  if (!release)
    return { ok: false, error: 'Failed to acquire task store lock.' }

  try {
    const existing = ensureTaskAdopted({
      taskId: args.taskId,
      taskListId,
      taskListDir: dir,
    })
    if (!existing) return { ok: false, error: 'Task not found' }

    const taskPath = getTaskPath(dir, existing.id)
    const merged: Task = {
      ...existing,
      ...args.update,
      id: existing.id,
      blocks: existing.blocks,
      blockedBy: existing.blockedBy,
    }

    atomicWriteJson(taskPath, merged)
    return { ok: true, updated: merged }
  } catch (error) {
    logError(error)
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    release()
  }
}

export function deleteTask(args: {
  taskId: string
  taskListId?: string
}): { ok: true } | { ok: false; error: string } {
  const taskListId = args.taskListId ?? getTaskListId()
  const dir = getTaskListDir(taskListId)
  safeMkdir(dir)

  const lockPath = join(dir, LOCK_FILENAME)
  const release = acquireFileLock(lockPath)
  if (!release)
    return { ok: false, error: 'Failed to acquire task store lock.' }

  try {
    const tombstones = readTombstones(dir)
    if (tombstones[args.taskId]) return { ok: true }

    const idNum = parseInt(args.taskId, 10)
    if (Number.isFinite(idNum) && idNum > readMaxId(dir)) writeMaxId(dir, idNum)

    // Remove task file from primary store if it exists.
    safeUnlink(getTaskPath(dir, args.taskId))

    // Mark as deleted (tombstone) so legacy tasks with the same ID don't reappear.
    writeTombstones(dir, { ...tombstones, [args.taskId]: Date.now() })

    // Best-effort: remove references from other tasks
    const tasks = listTasksFromDir(dir)
    for (const task of tasks) {
      const nextBlocks = task.blocks.filter(id => id !== args.taskId)
      const nextBlockedBy = task.blockedBy.filter(id => id !== args.taskId)
      if (
        nextBlocks.length !== task.blocks.length ||
        nextBlockedBy.length !== task.blockedBy.length
      ) {
        atomicWriteJson(getTaskPath(dir, task.id), {
          ...task,
          blocks: nextBlocks,
          blockedBy: nextBlockedBy,
        })
      }
    }

    return { ok: true }
  } catch (error) {
    logError(error)
    debugLogger.warn('TASK_DELETE_FAILED', {
      taskId: args.taskId,
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    release()
  }
}

export function addDependency(args: {
  taskId: string
  blocksTaskId: string
  taskListId?: string
}): { ok: true } | { ok: false; error: string } {
  const taskListId = args.taskListId ?? getTaskListId()
  const dir = getTaskListDir(taskListId)
  safeMkdir(dir)

  const lockPath = join(dir, LOCK_FILENAME)
  const release = acquireFileLock(lockPath)
  if (!release)
    return { ok: false, error: 'Failed to acquire task store lock.' }

  try {
    // Mutations must only operate on the primary task store to avoid implicitly
    // importing legacy compat tasks into the canonical Kode store.
    const a = ensureTaskAdopted({
      taskId: args.taskId,
      taskListId,
      taskListDir: dir,
    })
    const b = ensureTaskAdopted({
      taskId: args.blocksTaskId,
      taskListId,
      taskListDir: dir,
    })
    if (!a || !b) return { ok: false, error: 'Task not found' }

    if (args.taskId === args.blocksTaskId) {
      return { ok: false, error: 'A task cannot block itself.' }
    }

    // A cyclic graph never reaches a ready state, so reject the edge that would
    // close the loop instead of letting the task list deadlock silently.
    if (
      wouldCreateTaskCycle({
        tasks: listTasksFromDir(dir),
        taskId: args.taskId,
        blocksTaskId: args.blocksTaskId,
      })
    ) {
      return {
        ok: false,
        error: `Task #${args.taskId} cannot block #${args.blocksTaskId}: that would create a dependency cycle.`,
      }
    }

    const aBlocks = a.blocks.includes(args.blocksTaskId)
      ? a.blocks
      : [...a.blocks, args.blocksTaskId]
    const bBlockedBy = b.blockedBy.includes(args.taskId)
      ? b.blockedBy
      : [...b.blockedBy, args.taskId]

    atomicWriteJson(getTaskPath(dir, a.id), { ...a, blocks: aBlocks })
    atomicWriteJson(getTaskPath(dir, b.id), { ...b, blockedBy: bBlockedBy })

    return { ok: true }
  } catch (error) {
    logError(error)
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    release()
  }
}
