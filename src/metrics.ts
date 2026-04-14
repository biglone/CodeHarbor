import type { RateLimitReason, RateLimiterDecisionRecord, RateLimiterSnapshot } from "./rate-limiter";

const HISTOGRAM_INFINITY_LABEL = "+Inf";
const RATE_LIMIT_DECISION_SOURCES = ["local", "shared", "shared_fallback"] as const;
const RATE_LIMIT_REASON_VALUES = [
  "user_requests_per_window",
  "room_requests_per_window",
  "global_concurrency",
  "user_concurrency",
  "room_concurrency",
] as const;
const SHARED_RATE_LIMIT_MODES = ["local", "redis"] as const;

export const REQUEST_OUTCOME_VALUES = [
  "success",
  "failed",
  "timeout",
  "cancelled",
  "rate_limited",
  "ignored",
  "duplicate",
] as const;

export type RequestOutcomeMetric = (typeof REQUEST_OUTCOME_VALUES)[number];

export const FAILURE_OUTCOME_VALUES = ["failed", "timeout", "cancelled", "rate_limited"] as const;

export const AUTODEV_RUN_OUTCOME_VALUES = ["succeeded", "failed", "cancelled"] as const;
export type AutoDevRunOutcomeMetric = (typeof AUTODEV_RUN_OUTCOME_VALUES)[number];

export const AUTODEV_LOOP_STOP_REASON_VALUES = [
  "no_task",
  "drained",
  "max_runs",
  "deadline",
  "stop_requested",
  "no_progress",
  "task_incomplete",
] as const;
export type AutoDevLoopStopReasonMetric = (typeof AUTODEV_LOOP_STOP_REASON_VALUES)[number];

export const DEFAULT_DURATION_HISTOGRAM_BUCKETS_MS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000,
];

export interface HistogramSnapshot {
  buckets: number[];
  counts: number[];
  count: number;
  sum: number;
}

export interface RuntimeRequestMetricsSnapshot {
  total: number;
  outcomes: Record<RequestOutcomeMetric, number>;
  queueDurationMs: HistogramSnapshot;
  executionDurationMs: HistogramSnapshot;
  sendDurationMs: HistogramSnapshot;
}

export type RuntimeLimiterMetricsSnapshot = RateLimiterSnapshot;

export interface RuntimeAutoDevMetricsSnapshot {
  runs: Record<AutoDevRunOutcomeMetric, number>;
  loopStops: Record<AutoDevLoopStopReasonMetric, number>;
  tasksBlocked: number;
}

export interface RuntimeMetricsSnapshot {
  generatedAt: string;
  startedAt: string;
  activeExecutions: number;
  request: RuntimeRequestMetricsSnapshot;
  limiter: RuntimeLimiterMetricsSnapshot;
  autodev: RuntimeAutoDevMetricsSnapshot;
}

export class MutableHistogram {
  private readonly buckets: number[];
  private readonly counts: number[];
  private totalCount = 0;
  private totalSum = 0;

  constructor(buckets: number[]) {
    const normalized = buckets
      .map((value) => Math.floor(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);
    this.buckets = [...new Set(normalized)];
    this.counts = new Array(this.buckets.length + 1).fill(0);
  }

  observe(value: number): void {
    const safeValue = Math.max(0, Number.isFinite(value) ? value : 0);
    this.totalCount += 1;
    this.totalSum += safeValue;
    const index = this.buckets.findIndex((bound) => safeValue <= bound);
    if (index === -1) {
      this.counts[this.counts.length - 1] += 1;
      return;
    }
    this.counts[index] += 1;
  }

  snapshot(): HistogramSnapshot {
    return {
      buckets: [...this.buckets],
      counts: [...this.counts],
      count: this.totalCount,
      sum: this.totalSum,
    };
  }
}

interface RenderPrometheusInput {
  snapshot: RuntimeMetricsSnapshot | null;
  upgradeStats?: {
    total: number;
    succeeded: number;
    failed: number;
    running: number;
    avgDurationMs: number;
  } | null;
  latestUpgradeRun?: {
    status: "running" | "succeeded" | "failed";
    startedAt: number;
    finishedAt: number | null;
  } | null;
  appVersion: string | null;
  now?: number;
}

export function renderPrometheusMetrics(input: RenderPrometheusInput): string {
  const nowMs = Number.isFinite(input.now) ? (input.now as number) : Date.now();
  const lines: string[] = [];

  appendMetricMeta(lines, "codeharbor_up", "gauge", "Whether CodeHarbor metrics endpoint is reachable.");
  lines.push("codeharbor_up 1");

  appendMetricMeta(lines, "codeharbor_build_info", "gauge", "Build and version metadata.");
  lines.push(`codeharbor_build_info{version="${escapeLabelValue(input.appVersion || "unknown")}"} 1`);

  appendMetricMeta(lines, "codeharbor_metrics_snapshot_available", "gauge", "Whether runtime metrics snapshot is available.");
  lines.push(`codeharbor_metrics_snapshot_available ${input.snapshot ? 1 : 0}`);

  appendMetricMeta(
    lines,
    "codeharbor_metrics_snapshot_age_seconds",
    "gauge",
    "Age of latest runtime metrics snapshot in seconds.",
  );
  appendMetricMeta(
    lines,
    "codeharbor_metrics_snapshot_updated_at_seconds",
    "gauge",
    "Unix timestamp for latest runtime metrics snapshot.",
  );
  appendMetricMeta(lines, "codeharbor_process_started_at_seconds", "gauge", "CodeHarbor process start time.");

  if (!input.snapshot) {
    lines.push("codeharbor_metrics_snapshot_age_seconds 0");
    lines.push("codeharbor_metrics_snapshot_updated_at_seconds 0");
    lines.push("codeharbor_process_started_at_seconds 0");
    appendEmptyRequestMetrics(lines);
    appendAutoDevMetrics(lines, createEmptyAutoDevMetrics());
    appendUpgradeMetrics(lines, input.upgradeStats ?? null, input.latestUpgradeRun ?? null);
    lines.push("");
    return lines.join("\n");
  }

  const snapshotTimeMs = parseIsoTime(input.snapshot.generatedAt, nowMs);
  const startedAtMs = parseIsoTime(input.snapshot.startedAt, nowMs);
  const ageSeconds = Math.max(0, (nowMs - snapshotTimeMs) / 1_000);
  lines.push(`codeharbor_metrics_snapshot_age_seconds ${formatMetricValue(ageSeconds)}`);
  lines.push(`codeharbor_metrics_snapshot_updated_at_seconds ${formatMetricValue(snapshotTimeMs / 1_000)}`);
  lines.push(`codeharbor_process_started_at_seconds ${formatMetricValue(startedAtMs / 1_000)}`);

  appendRequestMetrics(lines, input.snapshot);
  appendAutoDevMetrics(lines, input.snapshot.autodev ?? createEmptyAutoDevMetrics());
  appendUpgradeMetrics(lines, input.upgradeStats ?? null, input.latestUpgradeRun ?? null);
  lines.push("");
  return lines.join("\n");
}

function appendRequestMetrics(lines: string[], snapshot: RuntimeMetricsSnapshot): void {
  const limiter = normalizeRuntimeLimiterMetrics(snapshot.limiter);
  appendMetricMeta(lines, "codeharbor_requests_total", "counter", "Total request outcomes by status.");
  appendMetricMeta(
    lines,
    "codeharbor_request_failures_total",
    "counter",
    "Total request failures grouped by failure category.",
  );
  appendMetricMeta(lines, "codeharbor_requests_active", "gauge", "In-flight request count.");
  appendMetricMeta(
    lines,
    "codeharbor_rate_limiter_active",
    "gauge",
    "Active rate limiter usage by scope (global/users/rooms).",
  );
  appendMetricMeta(
    lines,
    "codeharbor_rate_limiter_decisions_total",
    "counter",
    "Rate limiter decisions grouped by source and outcome.",
  );
  appendMetricMeta(
    lines,
    "codeharbor_rate_limiter_denied_total",
    "counter",
    "Rate limiter denied decisions grouped by reason.",
  );
  appendMetricMeta(lines, "codeharbor_rate_limiter_rejection_ratio", "gauge", "Rate limiter rejection ratio (0-1).");
  appendMetricMeta(
    lines,
    "codeharbor_rate_limiter_shared_mode",
    "gauge",
    "Shared limiter configured mode one-hot gauge (label=mode).",
  );
  appendMetricMeta(
    lines,
    "codeharbor_rate_limiter_shared_backend_ready",
    "gauge",
    "Whether shared limiter backend is active on this instance.",
  );
  appendMetricMeta(
    lines,
    "codeharbor_rate_limiter_shared_fallback_enabled",
    "gauge",
    "Whether shared limiter fallback-to-local is enabled.",
  );
  appendMetricMeta(
    lines,
    "codeharbor_rate_limiter_shared_errors_total",
    "counter",
    "Shared limiter backend error count.",
  );
  appendMetricMeta(
    lines,
    "codeharbor_rate_limiter_shared_fallback_total",
    "counter",
    "Rate limiter decisions executed through shared fallback path.",
  );
  appendMetricMeta(
    lines,
    "codeharbor_rate_limiter_recoveries_total",
    "counter",
    "Total recovery incidents from limiter rejection to next allowed request.",
  );
  appendMetricMeta(lines, "codeharbor_rate_limiter_recovery_last_ms", "gauge", "Last limiter recovery duration in milliseconds.");
  appendMetricMeta(
    lines,
    "codeharbor_rate_limiter_recovery_avg_ms",
    "gauge",
    "Average limiter recovery duration in milliseconds.",
  );
  appendMetricMeta(
    lines,
    "codeharbor_rate_limiter_recovery_pending_seconds",
    "gauge",
    "Seconds elapsed since latest unrecovered limiter rejection (0 when idle).",
  );

  for (const outcome of REQUEST_OUTCOME_VALUES) {
    const value = snapshot.request.outcomes[outcome] ?? 0;
    lines.push(`codeharbor_requests_total{outcome="${outcome}"} ${formatMetricValue(value)}`);
  }

  for (const category of FAILURE_OUTCOME_VALUES) {
    const value = snapshot.request.outcomes[category] ?? 0;
    lines.push(`codeharbor_request_failures_total{category="${category}"} ${formatMetricValue(value)}`);
  }

  lines.push(`codeharbor_requests_active ${formatMetricValue(snapshot.activeExecutions)}`);
  lines.push(`codeharbor_rate_limiter_active{scope="global"} ${formatMetricValue(limiter.activeGlobal)}`);
  lines.push(`codeharbor_rate_limiter_active{scope="users"} ${formatMetricValue(limiter.activeUsers)}`);
  lines.push(`codeharbor_rate_limiter_active{scope="rooms"} ${formatMetricValue(limiter.activeRooms)}`);

  lines.push(
    `codeharbor_rate_limiter_decisions_total{source="local",outcome="allowed"} ${formatMetricValue(
      limiter.decisionBreakdown.local.allowed,
    )}`,
  );
  lines.push(
    `codeharbor_rate_limiter_decisions_total{source="local",outcome="denied"} ${formatMetricValue(
      limiter.decisionBreakdown.local.denied,
    )}`,
  );
  lines.push(
    `codeharbor_rate_limiter_decisions_total{source="shared",outcome="allowed"} ${formatMetricValue(
      limiter.decisionBreakdown.shared.allowed,
    )}`,
  );
  lines.push(
    `codeharbor_rate_limiter_decisions_total{source="shared",outcome="denied"} ${formatMetricValue(
      limiter.decisionBreakdown.shared.denied,
    )}`,
  );
  lines.push(
    `codeharbor_rate_limiter_decisions_total{source="shared_fallback",outcome="allowed"} ${formatMetricValue(
      limiter.decisionBreakdown.sharedFallback.allowed,
    )}`,
  );
  lines.push(
    `codeharbor_rate_limiter_decisions_total{source="shared_fallback",outcome="denied"} ${formatMetricValue(
      limiter.decisionBreakdown.sharedFallback.denied,
    )}`,
  );

  for (const reason of RATE_LIMIT_REASON_VALUES) {
    lines.push(`codeharbor_rate_limiter_denied_total{reason="${reason}"} ${formatMetricValue(limiter.deniedByReason[reason] ?? 0)}`);
  }

  lines.push(`codeharbor_rate_limiter_rejection_ratio ${formatMetricValue(limiter.rejectionRate)}`);
  for (const mode of SHARED_RATE_LIMIT_MODES) {
    lines.push(`codeharbor_rate_limiter_shared_mode{mode="${mode}"} ${mode === limiter.sharedMode ? "1" : "0"}`);
  }
  lines.push(`codeharbor_rate_limiter_shared_backend_ready ${limiter.sharedBackendEnabled ? "1" : "0"}`);
  lines.push(`codeharbor_rate_limiter_shared_fallback_enabled ${limiter.fallbackToLocal ? "1" : "0"}`);
  lines.push(`codeharbor_rate_limiter_shared_errors_total ${formatMetricValue(limiter.decisionBreakdown.shared.errors)}`);
  lines.push(
    `codeharbor_rate_limiter_shared_fallback_total ${formatMetricValue(
      limiter.decisionBreakdown.sharedFallback.allowed + limiter.decisionBreakdown.sharedFallback.denied,
    )}`,
  );
  lines.push(`codeharbor_rate_limiter_recoveries_total ${formatMetricValue(limiter.recovery.count)}`);
  lines.push(`codeharbor_rate_limiter_recovery_last_ms ${formatMetricValue(limiter.recovery.lastMs)}`);
  lines.push(`codeharbor_rate_limiter_recovery_avg_ms ${formatMetricValue(limiter.recovery.avgMs)}`);
  lines.push(`codeharbor_rate_limiter_recovery_pending_seconds ${formatMetricValue(limiter.recovery.pendingForMs / 1_000)}`);

  appendHistogram(lines, "codeharbor_request_queue_duration_ms", "Request queue wait duration in milliseconds.", snapshot.request.queueDurationMs);
  appendHistogram(
    lines,
    "codeharbor_request_execution_duration_ms",
    "Request execution duration in milliseconds.",
    snapshot.request.executionDurationMs,
  );
  appendHistogram(lines, "codeharbor_request_send_duration_ms", "Request response send duration in milliseconds.", snapshot.request.sendDurationMs);
}

function appendEmptyRequestMetrics(lines: string[]): void {
  const empty: RuntimeMetricsSnapshot = {
    generatedAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    activeExecutions: 0,
    request: {
      total: 0,
      outcomes: buildEmptyOutcomes(),
      queueDurationMs: createEmptyHistogram(),
      executionDurationMs: createEmptyHistogram(),
      sendDurationMs: createEmptyHistogram(),
    },
    limiter: {
      ...createEmptyLimiterMetrics(),
    },
    autodev: createEmptyAutoDevMetrics(),
  };
  appendRequestMetrics(lines, empty);
}

function appendAutoDevMetrics(lines: string[], snapshot: RuntimeAutoDevMetricsSnapshot): void {
  appendMetricMeta(lines, "codeharbor_autodev_runs_total", "counter", "AutoDev run outcomes.");
  appendMetricMeta(lines, "codeharbor_autodev_loop_stops_total", "counter", "AutoDev loop stop reasons.");
  appendMetricMeta(lines, "codeharbor_autodev_tasks_blocked_total", "counter", "AutoDev tasks marked as blocked.");

  for (const outcome of AUTODEV_RUN_OUTCOME_VALUES) {
    lines.push(`codeharbor_autodev_runs_total{outcome="${outcome}"} ${formatMetricValue(snapshot.runs[outcome] ?? 0)}`);
  }

  for (const reason of AUTODEV_LOOP_STOP_REASON_VALUES) {
    lines.push(
      `codeharbor_autodev_loop_stops_total{reason="${reason}"} ${formatMetricValue(snapshot.loopStops[reason] ?? 0)}`,
    );
  }

  lines.push(`codeharbor_autodev_tasks_blocked_total ${formatMetricValue(snapshot.tasksBlocked)}`);
}

function appendUpgradeMetrics(
  lines: string[],
  stats: {
    total: number;
    succeeded: number;
    failed: number;
    running: number;
    avgDurationMs: number;
  } | null,
  latestRun: {
    status: "running" | "succeeded" | "failed";
    startedAt: number;
    finishedAt: number | null;
  } | null,
): void {
  appendMetricMeta(lines, "codeharbor_upgrade_runs_total", "counter", "Upgrade runs grouped by status.");
  appendMetricMeta(lines, "codeharbor_upgrade_avg_duration_ms", "gauge", "Average duration for finished upgrade runs.");
  appendMetricMeta(
    lines,
    "codeharbor_upgrade_last_run_status",
    "gauge",
    "Latest upgrade status one-hot gauge (label=status).",
  );
  appendMetricMeta(
    lines,
    "codeharbor_upgrade_last_run_started_at_seconds",
    "gauge",
    "Unix timestamp for latest upgrade start time.",
  );
  appendMetricMeta(
    lines,
    "codeharbor_upgrade_last_run_finished_at_seconds",
    "gauge",
    "Unix timestamp for latest upgrade finish time (0 when running/absent).",
  );

  const safeStats = {
    total: Math.max(0, Math.floor(stats?.total ?? 0)),
    succeeded: Math.max(0, Math.floor(stats?.succeeded ?? 0)),
    failed: Math.max(0, Math.floor(stats?.failed ?? 0)),
    running: Math.max(0, Math.floor(stats?.running ?? 0)),
    avgDurationMs: Math.max(0, stats?.avgDurationMs ?? 0),
  };

  lines.push(`codeharbor_upgrade_runs_total{status="running"} ${formatMetricValue(safeStats.running)}`);
  lines.push(`codeharbor_upgrade_runs_total{status="succeeded"} ${formatMetricValue(safeStats.succeeded)}`);
  lines.push(`codeharbor_upgrade_runs_total{status="failed"} ${formatMetricValue(safeStats.failed)}`);
  lines.push(`codeharbor_upgrade_runs_total{status="all"} ${formatMetricValue(safeStats.total)}`);
  lines.push(`codeharbor_upgrade_avg_duration_ms ${formatMetricValue(safeStats.avgDurationMs)}`);

  const currentStatus = latestRun?.status ?? "none";
  const statusLabels = ["none", "running", "succeeded", "failed"] as const;
  for (const status of statusLabels) {
    lines.push(`codeharbor_upgrade_last_run_status{status="${status}"} ${status === currentStatus ? "1" : "0"}`);
  }
  lines.push(
    `codeharbor_upgrade_last_run_started_at_seconds ${formatMetricValue(
      latestRun ? Math.max(0, latestRun.startedAt / 1_000) : 0,
    )}`,
  );
  lines.push(
    `codeharbor_upgrade_last_run_finished_at_seconds ${formatMetricValue(
      latestRun?.finishedAt ? Math.max(0, latestRun.finishedAt / 1_000) : 0,
    )}`,
  );
}

function appendHistogram(lines: string[], name: string, help: string, snapshot: HistogramSnapshot): void {
  appendMetricMeta(lines, name, "histogram", help);
  const buckets = normalizeHistogramBuckets(snapshot.buckets);
  const counts = normalizeHistogramCounts(snapshot.counts, buckets.length + 1);
  let cumulative = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    cumulative += counts[index] ?? 0;
    lines.push(`${name}_bucket{le="${buckets[index]}"} ${formatMetricValue(cumulative)}`);
  }
  cumulative += counts[counts.length - 1] ?? 0;
  lines.push(`${name}_bucket{le="${HISTOGRAM_INFINITY_LABEL}"} ${formatMetricValue(cumulative)}`);
  lines.push(`${name}_sum ${formatMetricValue(Math.max(0, snapshot.sum || 0))}`);
  lines.push(`${name}_count ${formatMetricValue(Math.max(0, snapshot.count || 0))}`);
}

function createEmptyHistogram(): HistogramSnapshot {
  return {
    buckets: DEFAULT_DURATION_HISTOGRAM_BUCKETS_MS,
    counts: new Array(DEFAULT_DURATION_HISTOGRAM_BUCKETS_MS.length + 1).fill(0),
    count: 0,
    sum: 0,
  };
}

function normalizeHistogramBuckets(rawBuckets: number[]): number[] {
  return rawBuckets
    .map((value) => Math.floor(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
}

function normalizeHistogramCounts(rawCounts: number[], expectedLength: number): number[] {
  const counts = new Array(expectedLength).fill(0);
  for (let index = 0; index < expectedLength; index += 1) {
    const value = rawCounts[index];
    counts[index] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }
  return counts;
}

function appendMetricMeta(lines: string[], name: string, type: "gauge" | "counter" | "histogram", help: string): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
}

function parseIsoTime(value: string, fallbackMs: number): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return fallbackMs;
  }
  return parsed;
}

function formatMetricValue(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(6).replace(/\.?0+$/, "");
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function buildEmptyOutcomes(): Record<RequestOutcomeMetric, number> {
  return {
    success: 0,
    failed: 0,
    timeout: 0,
    cancelled: 0,
    rate_limited: 0,
    ignored: 0,
    duplicate: 0,
  };
}

function createEmptyAutoDevMetrics(): RuntimeAutoDevMetricsSnapshot {
  return {
    runs: {
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    },
    loopStops: {
      no_task: 0,
      drained: 0,
      max_runs: 0,
      deadline: 0,
      stop_requested: 0,
      no_progress: 0,
      task_incomplete: 0,
    },
    tasksBlocked: 0,
  };
}

export function parseRuntimeMetricsSnapshot(raw: string): RuntimeMetricsSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const candidate = parsed as Partial<RuntimeMetricsSnapshot>;
  if (!candidate.request || !candidate.limiter) {
    return null;
  }
  return {
    ...(candidate as RuntimeMetricsSnapshot),
    limiter: parseRuntimeLimiterMetrics((candidate as { limiter?: unknown }).limiter),
    autodev: parseRuntimeAutoDevMetrics((candidate as { autodev?: unknown }).autodev),
  };
}

function createEmptyLimiterMetrics(): RuntimeLimiterMetricsSnapshot {
  return {
    activeGlobal: 0,
    activeUsers: 0,
    activeRooms: 0,
    sharedMode: "local",
    sharedBackendEnabled: false,
    fallbackToLocal: true,
    decisionsTotal: 0,
    allowedTotal: 0,
    deniedTotal: 0,
    rejectionRate: 0,
    decisionBreakdown: {
      local: {
        allowed: 0,
        denied: 0,
      },
      shared: {
        allowed: 0,
        denied: 0,
        errors: 0,
      },
      sharedFallback: {
        allowed: 0,
        denied: 0,
      },
    },
    deniedByReason: {
      user_requests_per_window: 0,
      room_requests_per_window: 0,
      global_concurrency: 0,
      user_concurrency: 0,
      room_concurrency: 0,
    },
    recovery: {
      count: 0,
      lastMs: 0,
      avgMs: 0,
      pendingSinceIso: null,
      pendingForMs: 0,
    },
    recent: [],
  };
}

function normalizeRuntimeLimiterMetrics(raw: RuntimeLimiterMetricsSnapshot | null | undefined): RuntimeLimiterMetricsSnapshot {
  const fallback = createEmptyLimiterMetrics();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fallback;
  }
  const candidate = raw as Partial<RuntimeLimiterMetricsSnapshot> & {
    decisionBreakdown?: {
      local?: { allowed?: unknown; denied?: unknown };
      shared?: { allowed?: unknown; denied?: unknown; errors?: unknown };
      sharedFallback?: { allowed?: unknown; denied?: unknown };
    };
    deniedByReason?: Partial<Record<RateLimitReason, unknown>>;
    recovery?: {
      count?: unknown;
      lastMs?: unknown;
      avgMs?: unknown;
      pendingSinceIso?: unknown;
      pendingForMs?: unknown;
    };
    recent?: unknown;
  };
  const sharedMode = candidate.sharedMode === "redis" ? "redis" : "local";
  const deniedByReason = (candidate.deniedByReason ?? {}) as Partial<Record<RateLimitReason, unknown>>;
  const recovery = (candidate.recovery ?? {}) as {
    count?: unknown;
    lastMs?: unknown;
    avgMs?: unknown;
    pendingSinceIso?: unknown;
    pendingForMs?: unknown;
  };
  const recent = parseLimiterDecisionRecords(candidate.recent);

  const localAllowed = parseNonNegativeInt(candidate.decisionBreakdown?.local?.allowed);
  const localDenied = parseNonNegativeInt(candidate.decisionBreakdown?.local?.denied);
  const sharedAllowed = parseNonNegativeInt(candidate.decisionBreakdown?.shared?.allowed);
  const sharedDenied = parseNonNegativeInt(candidate.decisionBreakdown?.shared?.denied);
  const sharedErrors = parseNonNegativeInt(candidate.decisionBreakdown?.shared?.errors);
  const fallbackAllowed = parseNonNegativeInt(candidate.decisionBreakdown?.sharedFallback?.allowed);
  const fallbackDenied = parseNonNegativeInt(candidate.decisionBreakdown?.sharedFallback?.denied);
  const allowedTotal =
    parseNonNegativeInt(candidate.allowedTotal) || localAllowed + sharedAllowed + fallbackAllowed;
  const deniedTotal =
    parseNonNegativeInt(candidate.deniedTotal) || localDenied + sharedDenied + fallbackDenied;
  const decisionsTotal =
    parseNonNegativeInt(candidate.decisionsTotal) || Math.max(0, allowedTotal + deniedTotal);
  const rejectionRate =
    typeof candidate.rejectionRate === "number" && Number.isFinite(candidate.rejectionRate)
      ? Math.max(0, Math.min(1, candidate.rejectionRate))
      : decisionsTotal > 0
        ? deniedTotal / decisionsTotal
        : 0;

  return {
    activeGlobal: parseNonNegativeInt(candidate.activeGlobal),
    activeUsers: parseNonNegativeInt(candidate.activeUsers),
    activeRooms: parseNonNegativeInt(candidate.activeRooms),
    sharedMode,
    sharedBackendEnabled: Boolean(candidate.sharedBackendEnabled),
    fallbackToLocal: candidate.fallbackToLocal !== false,
    decisionsTotal,
    allowedTotal,
    deniedTotal,
    rejectionRate,
    decisionBreakdown: {
      local: {
        allowed: localAllowed,
        denied: localDenied,
      },
      shared: {
        allowed: sharedAllowed,
        denied: sharedDenied,
        errors: sharedErrors,
      },
      sharedFallback: {
        allowed: fallbackAllowed,
        denied: fallbackDenied,
      },
    },
    deniedByReason: {
      user_requests_per_window: parseNonNegativeInt(deniedByReason.user_requests_per_window),
      room_requests_per_window: parseNonNegativeInt(deniedByReason.room_requests_per_window),
      global_concurrency: parseNonNegativeInt(deniedByReason.global_concurrency),
      user_concurrency: parseNonNegativeInt(deniedByReason.user_concurrency),
      room_concurrency: parseNonNegativeInt(deniedByReason.room_concurrency),
    },
    recovery: {
      count: parseNonNegativeInt(recovery.count),
      lastMs: parseNonNegativeInt(recovery.lastMs),
      avgMs: parseNonNegativeInt(recovery.avgMs),
      pendingSinceIso: typeof recovery.pendingSinceIso === "string" ? recovery.pendingSinceIso : null,
      pendingForMs: parseNonNegativeInt(recovery.pendingForMs),
    },
    recent,
  };
}

function parseLimiterDecisionRecords(value: unknown): RateLimiterDecisionRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const records: RateLimiterDecisionRecord[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const candidate = entry as Partial<RateLimiterDecisionRecord>;
    const source = RATE_LIMIT_DECISION_SOURCES.includes(candidate.source as (typeof RATE_LIMIT_DECISION_SOURCES)[number])
      ? (candidate.source as (typeof RATE_LIMIT_DECISION_SOURCES)[number])
      : "local";
    const outcome =
      candidate.outcome === "allowed" || candidate.outcome === "denied" || candidate.outcome === "shared_error"
        ? candidate.outcome
        : "denied";
    const reason =
      candidate.reason === "user_requests_per_window" ||
      candidate.reason === "room_requests_per_window" ||
      candidate.reason === "global_concurrency" ||
      candidate.reason === "user_concurrency" ||
      candidate.reason === "room_concurrency" ||
      candidate.reason === "shared_backend_error"
        ? candidate.reason
        : null;
    records.push({
      at: typeof candidate.at === "string" ? candidate.at : new Date(0).toISOString(),
      source,
      outcome,
      reason,
      retryAfterMs: parseNullableNonNegativeInt(candidate.retryAfterMs),
    });
  }
  return records;
}

function parseRuntimeLimiterMetrics(value: unknown): RuntimeLimiterMetricsSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createEmptyLimiterMetrics();
  }
  return normalizeRuntimeLimiterMetrics(value as RuntimeLimiterMetricsSnapshot);
}

function parseRuntimeAutoDevMetrics(value: unknown): RuntimeAutoDevMetricsSnapshot {
  const fallback = createEmptyAutoDevMetrics();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const candidate = value as Partial<RuntimeAutoDevMetricsSnapshot> & {
    runs?: Partial<Record<AutoDevRunOutcomeMetric, unknown>>;
    loopStops?: Partial<Record<AutoDevLoopStopReasonMetric, unknown>>;
  };
  return {
    runs: {
      succeeded: parseNonNegativeInt(candidate.runs?.succeeded),
      failed: parseNonNegativeInt(candidate.runs?.failed),
      cancelled: parseNonNegativeInt(candidate.runs?.cancelled),
    },
    loopStops: {
      no_task: parseNonNegativeInt(candidate.loopStops?.no_task),
      drained: parseNonNegativeInt(candidate.loopStops?.drained),
      max_runs: parseNonNegativeInt(candidate.loopStops?.max_runs),
      deadline: parseNonNegativeInt(candidate.loopStops?.deadline),
      stop_requested: parseNonNegativeInt(candidate.loopStops?.stop_requested),
      no_progress: parseNonNegativeInt(candidate.loopStops?.no_progress),
      task_incomplete: parseNonNegativeInt(candidate.loopStops?.task_incomplete),
    },
    tasksBlocked: parseNonNegativeInt(candidate.tasksBlocked),
  };
}

function parseNonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function parseNullableNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}
