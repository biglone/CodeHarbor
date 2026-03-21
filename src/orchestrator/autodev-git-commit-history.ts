import type { AutoDevGitCommitResult } from "./autodev-git";

export interface AutoDevGitCommitRecord {
  at: string;
  sessionKey: string;
  taskId: string;
  result: AutoDevGitCommitResult;
}

export function recordAutoDevGitCommit(
  records: AutoDevGitCommitRecord[],
  sessionKey: string,
  taskId: string,
  result: AutoDevGitCommitResult,
  maxHistory: number,
): void {
  records.push({
    at: new Date().toISOString(),
    sessionKey,
    taskId,
    result,
  });
  if (records.length > maxHistory) {
    records.splice(0, records.length - maxHistory);
  }
}

export function listAutoDevGitCommitRecords(records: AutoDevGitCommitRecord[], limit: number): AutoDevGitCommitRecord[] {
  const safeLimit = Math.max(1, Math.floor(limit));
  return records.slice(Math.max(0, records.length - safeLimit)).reverse();
}
