import type { WorkflowRunSnapshot } from "../workflow/multi-agent-workflow";
import type { AutoDevRunSnapshot } from "./autodev-runner";

interface PruneRunSnapshotsInput {
  workflowSnapshots: Map<string, WorkflowRunSnapshot>;
  autoDevSnapshots: Map<string, AutoDevRunSnapshot>;
  now: number;
  ttlMs: number;
  maxEntries: number;
}

export function pruneRunSnapshots(input: PruneRunSnapshotsInput): void {
  pruneSnapshotMap(
    input.workflowSnapshots,
    input.now,
    input.ttlMs,
    input.maxEntries,
    (snapshot) => snapshot.state !== "running",
    (snapshot) => snapshot.endedAt ?? snapshot.startedAt,
  );
  pruneSnapshotMap(
    input.autoDevSnapshots,
    input.now,
    input.ttlMs,
    input.maxEntries,
    (snapshot) => snapshot.state !== "running",
    (snapshot) => snapshot.endedAt ?? snapshot.startedAt,
  );
}

function pruneSnapshotMap<T>(
  snapshots: Map<string, T>,
  now: number,
  ttlMs: number,
  maxEntries: number,
  isPrunable: (snapshot: T) => boolean,
  resolveSnapshotTimeIso: (snapshot: T) => string | null,
): void {
  const staleKeys: string[] = [];
  const candidatesForOverflow: Array<{ key: string; timestamp: number }> = [];

  for (const [key, snapshot] of snapshots.entries()) {
    if (!isPrunable(snapshot)) {
      continue;
    }

    const timeIso = resolveSnapshotTimeIso(snapshot);
    if (!timeIso) {
      staleKeys.push(key);
      continue;
    }

    const timestamp = Date.parse(timeIso);
    if (!Number.isFinite(timestamp)) {
      staleKeys.push(key);
      continue;
    }

    if (now - timestamp > ttlMs) {
      staleKeys.push(key);
      continue;
    }

    candidatesForOverflow.push({ key, timestamp });
  }

  for (const key of staleKeys) {
    snapshots.delete(key);
  }

  if (snapshots.size <= maxEntries) {
    return;
  }

  const overflow = snapshots.size - maxEntries;
  if (overflow <= 0) {
    return;
  }

  candidatesForOverflow.sort((a, b) => a.timestamp - b.timestamp);
  for (let index = 0; index < overflow && index < candidatesForOverflow.length; index += 1) {
    snapshots.delete(candidatesForOverflow[index].key);
  }
}
