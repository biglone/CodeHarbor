import type { AutoDevRunSnapshot } from "./autodev-runner";
import { loadAutoDevContext, selectAutoDevTask, summarizeAutoDevTasks } from "../workflow/autodev";

export async function buildAutoDevChatRuntimeContext(
  workdir: string,
  snapshot: AutoDevRunSnapshot | null,
): Promise<string | null> {
  if (!snapshot || (snapshot.mode === "idle" && snapshot.state === "idle")) {
    return null;
  }

  const context = await loadAutoDevContext(workdir);
  if (!context.taskListContent || context.tasks.length === 0) {
    return null;
  }

  const summary = summarizeAutoDevTasks(context.tasks);
  const hasExecutableTasks = summary.pending > 0 || summary.inProgress > 0;
  const nextTask = hasExecutableTasks ? selectAutoDevTask(context.tasks)?.id ?? "N/A" : "N/A";
  const instruction = hasExecutableTasks
    ? "If user asks for next steps, prioritize pending or in-progress AutoDev tasks."
    : "AutoDev has no executable tasks. Do not suggest rerunning completed tasks unless the user explicitly asks to rerun.";

  return [
    "[autodev_runtime]",
    `snapshotState=${snapshot.state}`,
    `snapshotMode=${snapshot.mode}`,
    `snapshotTask=${snapshot.taskId ?? "N/A"}`,
    `tasks=total=${summary.total},pending=${summary.pending},in_progress=${summary.inProgress},completed=${summary.completed},blocked=${summary.blocked},cancelled=${summary.cancelled}`,
    `status=${hasExecutableTasks ? "active" : "completed"}`,
    `nextTask=${nextTask}`,
    `instruction=${instruction}`,
    "[/autodev_runtime]",
  ].join("\n");
}
