export const DESCRIPTION = 'Update a task in the task list.'

export const PROMPT = `Use this tool to update a task’s status or details.

Guidelines:
- Only mark a task as completed when it is fully done (tests pass, no blockers).
- If you get blocked, keep the task in_progress and create a new task describing what to unblock.
- Use status progression: pending → in_progress → completed.
- A task with unfinished dependencies cannot be moved to in_progress: the update is rejected and the blocking task IDs are returned. Complete or remove those dependencies first.
- Dependencies that would create a cycle (including a task blocking itself) are rejected; the response lists what was not applied.
- Set status to "deleted" to permanently remove a task.`
