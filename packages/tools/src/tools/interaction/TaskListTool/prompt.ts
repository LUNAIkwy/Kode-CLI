export const DESCRIPTION = 'List all tasks in the task list.'

export const PROMPT = `Use this tool to list tasks in summary form.

Tips:
- Prefer working on ready tasks in ID order when multiple are unblocked.
- A task is ready when it is pending and none of its blockedBy tasks are still incomplete.
- The listing also reports which tasks are ready now, along with any dependency cycles or deadlocks.`
