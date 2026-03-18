const HISTOGRAM_INFINITY_LABEL = "+Inf";

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

export interface RuntimeLimiterMetricsSnapshot {
  activeGlobal: number;
  activeUsers: number;
  activeRooms: number;
}

export interface RuntimeMetricsSnapshot {
  generatedAt: string;
  startedAt: string;
  activeExecutions: number;
  request: RuntimeRequestMetricsSnapshot;
  limiter: RuntimeLimiterMetricsSnapshot;
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
  appendUpgradeMetrics(lines, input.upgradeStats ?? null, input.latestUpgradeRun ?? null);
  lines.push("");
  return lines.join("\n");
}

function appendRequestMetrics(lines: string[], snapshot: RuntimeMetricsSnapshot): void {
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

  for (const outcome of REQUEST_OUTCOME_VALUES) {
    const value = snapshot.request.outcomes[outcome] ?? 0;
    lines.push(`codeharbor_requests_total{outcome="${outcome}"} ${formatMetricValue(value)}`);
  }

  for (const category of FAILURE_OUTCOME_VALUES) {
    const value = snapshot.request.outcomes[category] ?? 0;
    lines.push(`codeharbor_request_failures_total{category="${category}"} ${formatMetricValue(value)}`);
  }

  lines.push(`codeharbor_requests_active ${formatMetricValue(snapshot.activeExecutions)}`);
  lines.push(`codeharbor_rate_limiter_active{scope="global"} ${formatMetricValue(snapshot.limiter.activeGlobal)}`);
  lines.push(`codeharbor_rate_limiter_active{scope="users"} ${formatMetricValue(snapshot.limiter.activeUsers)}`);
  lines.push(`codeharbor_rate_limiter_active{scope="rooms"} ${formatMetricValue(snapshot.limiter.activeRooms)}`);

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
      activeGlobal: 0,
      activeUsers: 0,
      activeRooms: 0,
    },
  };
  appendRequestMetrics(lines, empty);
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
  return candidate as RuntimeMetricsSnapshot;
}
