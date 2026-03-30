import type { Mutex } from "async-mutex";

import type { DocumentContextItem } from "../document-context";
import type { CodexExecutor } from "../executor/codex-executor";
import type { CodexSessionRuntime } from "../executor/codex-session-runtime";
import type { RequestOutcomeMetric } from "../metrics";
import type { BackendModelRouteProfile } from "../routing/backend-model-router";
import type { TriggerPolicy } from "../config";

export interface SessionLockEntry {
  mutex: Mutex;
  lastUsedAt: number;
}

export type RequestOutcome = RequestOutcomeMetric;

export interface RunningExecution {
  requestId: string;
  startedAt: number;
  cancel: () => void;
}

export interface RoomRuntimeConfig {
  source: "default" | "room";
  enabled: boolean;
  triggerPolicy: TriggerPolicy;
  workdir: string;
}

export interface SessionBackendOverride {
  profile: BackendModelRouteProfile;
  updatedAt: number;
}

export interface SessionBackendDecision {
  profile: BackendModelRouteProfile;
  source: "manual_override" | "rule" | "default";
  reasonCode: "manual_override" | "rule_match" | "default_fallback" | "factory_unavailable";
  ruleId: string | null;
}

export interface BackendRuntimeBundle {
  profile: BackendModelRouteProfile;
  executor: CodexExecutor;
  sessionRuntime: CodexSessionRuntime;
}

export interface ImageSelectionResult {
  imagePaths: string[];
  acceptedCount: number;
  skippedMissingPath: number;
  skippedMissingLocalFile: number;
  skippedUnsupportedMime: number;
  skippedTooLarge: number;
  skippedOverLimit: number;
  notice: string | null;
}

export interface DocumentExtractionSummary {
  documents: DocumentContextItem[];
  notice: string | null;
}
