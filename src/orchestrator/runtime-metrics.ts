import {
  DEFAULT_DURATION_HISTOGRAM_BUCKETS_MS,
  MutableHistogram,
  type AutoDevLoopStopReasonMetric,
  type AutoDevRunOutcomeMetric,
  type RequestOutcomeMetric,
  type RuntimeMetricsSnapshot,
} from "../metrics";

export class RequestMetrics {
  private total = 0;
  private success = 0;
  private failed = 0;
  private timeout = 0;
  private cancelled = 0;
  private rateLimited = 0;
  private ignored = 0;
  private duplicate = 0;
  private totalQueueMs = 0;
  private totalExecMs = 0;
  private totalSendMs = 0;
  private readonly queueDurationMs = new MutableHistogram(DEFAULT_DURATION_HISTOGRAM_BUCKETS_MS);
  private readonly executionDurationMs = new MutableHistogram(DEFAULT_DURATION_HISTOGRAM_BUCKETS_MS);
  private readonly sendDurationMs = new MutableHistogram(DEFAULT_DURATION_HISTOGRAM_BUCKETS_MS);

  record(outcome: RequestOutcomeMetric, queueMs: number, execMs: number, sendMs: number): void {
    const safeQueueMs = Math.max(0, queueMs);
    const safeExecMs = Math.max(0, execMs);
    const safeSendMs = Math.max(0, sendMs);
    this.total += 1;
    this.totalQueueMs += safeQueueMs;
    this.totalExecMs += safeExecMs;
    this.totalSendMs += safeSendMs;
    this.queueDurationMs.observe(safeQueueMs);
    this.executionDurationMs.observe(safeExecMs);
    this.sendDurationMs.observe(safeSendMs);

    if (outcome === "success") {
      this.success += 1;
      return;
    }
    if (outcome === "failed") {
      this.failed += 1;
      return;
    }
    if (outcome === "timeout") {
      this.timeout += 1;
      return;
    }
    if (outcome === "cancelled") {
      this.cancelled += 1;
      return;
    }
    if (outcome === "rate_limited") {
      this.rateLimited += 1;
      return;
    }
    if (outcome === "ignored") {
      this.ignored += 1;
      return;
    }
    this.duplicate += 1;
  }

  runtimeSnapshot(): RuntimeMetricsSnapshot["request"] {
    return {
      total: this.total,
      outcomes: {
        success: this.success,
        failed: this.failed,
        timeout: this.timeout,
        cancelled: this.cancelled,
        rate_limited: this.rateLimited,
        ignored: this.ignored,
        duplicate: this.duplicate,
      },
      queueDurationMs: this.queueDurationMs.snapshot(),
      executionDurationMs: this.executionDurationMs.snapshot(),
      sendDurationMs: this.sendDurationMs.snapshot(),
    };
  }

  snapshot(activeExecutions: number): {
    total: number;
    success: number;
    failed: number;
    timeout: number;
    cancelled: number;
    rateLimited: number;
    ignored: number;
    duplicate: number;
    activeExecutions: number;
    avgQueueMs: number;
    avgExecMs: number;
    avgSendMs: number;
  } {
    const divisor = this.total > 0 ? this.total : 1;
    return {
      total: this.total,
      success: this.success,
      failed: this.failed,
      timeout: this.timeout,
      cancelled: this.cancelled,
      rateLimited: this.rateLimited,
      ignored: this.ignored,
      duplicate: this.duplicate,
      activeExecutions,
      avgQueueMs: Math.round(this.totalQueueMs / divisor),
      avgExecMs: Math.round(this.totalExecMs / divisor),
      avgSendMs: Math.round(this.totalSendMs / divisor),
    };
  }
}

export class AutoDevRuntimeMetrics {
  private succeeded = 0;
  private failed = 0;
  private cancelled = 0;
  private loopNoTask = 0;
  private loopDrained = 0;
  private loopMaxRuns = 0;
  private loopDeadline = 0;
  private loopStopRequested = 0;
  private loopNoProgress = 0;
  private loopTaskIncomplete = 0;
  private tasksBlocked = 0;

  recordRunOutcome(outcome: AutoDevRunOutcomeMetric): void {
    if (outcome === "succeeded") {
      this.succeeded += 1;
      return;
    }
    if (outcome === "failed") {
      this.failed += 1;
      return;
    }
    this.cancelled += 1;
  }

  recordLoopStop(reason: AutoDevLoopStopReasonMetric): void {
    if (reason === "no_task") {
      this.loopNoTask += 1;
      return;
    }
    if (reason === "drained") {
      this.loopDrained += 1;
      return;
    }
    if (reason === "max_runs") {
      this.loopMaxRuns += 1;
      return;
    }
    if (reason === "deadline") {
      this.loopDeadline += 1;
      return;
    }
    if (reason === "stop_requested") {
      this.loopStopRequested += 1;
      return;
    }
    if (reason === "no_progress") {
      this.loopNoProgress += 1;
      return;
    }
    this.loopTaskIncomplete += 1;
  }

  recordTaskBlocked(): void {
    this.tasksBlocked += 1;
  }

  runtimeSnapshot(): RuntimeMetricsSnapshot["autodev"] {
    return {
      runs: {
        succeeded: this.succeeded,
        failed: this.failed,
        cancelled: this.cancelled,
      },
      loopStops: {
        no_task: this.loopNoTask,
        drained: this.loopDrained,
        max_runs: this.loopMaxRuns,
        deadline: this.loopDeadline,
        stop_requested: this.loopStopRequested,
        no_progress: this.loopNoProgress,
        task_incomplete: this.loopTaskIncomplete,
      },
      tasksBlocked: this.tasksBlocked,
    };
  }
}

export interface MediaMetricCounters {
  imageAccepted: number;
  imageSkippedMissingPath: number;
  imageSkippedMissingLocalFile: number;
  imageSkippedUnsupportedMime: number;
  imageSkippedTooLarge: number;
  imageSkippedOverLimit: number;
  audioTranscribed: number;
  audioFailed: number;
  audioSkippedTooLarge: number;
  claudeImageFallbackTriggered: number;
  claudeImageFallbackSucceeded: number;
  claudeImageFallbackFailed: number;
}

export interface MediaMetricEvent {
  at: string;
  type: string;
  requestId: string;
  sessionKey: string;
  detail: string;
}

interface MediaImageSelectionResult {
  imagePaths: string[];
  skippedMissingPath: number;
  skippedMissingLocalFile: number;
  skippedUnsupportedMime: number;
  skippedTooLarge: number;
  skippedOverLimit: number;
}

export class MediaMetrics {
  private readonly counters: MediaMetricCounters = {
    imageAccepted: 0,
    imageSkippedMissingPath: 0,
    imageSkippedMissingLocalFile: 0,
    imageSkippedUnsupportedMime: 0,
    imageSkippedTooLarge: 0,
    imageSkippedOverLimit: 0,
    audioTranscribed: 0,
    audioFailed: 0,
    audioSkippedTooLarge: 0,
    claudeImageFallbackTriggered: 0,
    claudeImageFallbackSucceeded: 0,
    claudeImageFallbackFailed: 0,
  };

  private readonly events: MediaMetricEvent[] = [];
  private readonly maxEvents: number;

  constructor(maxEvents = 300) {
    this.maxEvents = Math.max(20, maxEvents);
  }

  recordImageSelection(input: { requestId: string; sessionKey: string; result: MediaImageSelectionResult }): void {
    const { requestId, sessionKey, result } = input;
    if (result.imagePaths.length > 0) {
      this.counters.imageAccepted += result.imagePaths.length;
      this.pushEvent(requestId, sessionKey, "image.accepted", `count=${result.imagePaths.length}`);
    }
    if (result.skippedMissingPath > 0) {
      this.counters.imageSkippedMissingPath += result.skippedMissingPath;
      this.pushEvent(requestId, sessionKey, "image.skipped_missing_path", `count=${result.skippedMissingPath}`);
    }
    if (result.skippedMissingLocalFile > 0) {
      this.counters.imageSkippedMissingLocalFile += result.skippedMissingLocalFile;
      this.pushEvent(requestId, sessionKey, "image.skipped_missing_local_file", `count=${result.skippedMissingLocalFile}`);
    }
    if (result.skippedUnsupportedMime > 0) {
      this.counters.imageSkippedUnsupportedMime += result.skippedUnsupportedMime;
      this.pushEvent(requestId, sessionKey, "image.skipped_mime", `count=${result.skippedUnsupportedMime}`);
    }
    if (result.skippedTooLarge > 0) {
      this.counters.imageSkippedTooLarge += result.skippedTooLarge;
      this.pushEvent(requestId, sessionKey, "image.skipped_size", `count=${result.skippedTooLarge}`);
    }
    if (result.skippedOverLimit > 0) {
      this.counters.imageSkippedOverLimit += result.skippedOverLimit;
      this.pushEvent(requestId, sessionKey, "image.skipped_limit", `count=${result.skippedOverLimit}`);
    }
  }

  recordAudioTranscription(input: {
    requestId: string;
    sessionKey: string;
    transcribedCount: number;
    failedCount: number;
    skippedTooLarge: number;
  }): void {
    const { requestId, sessionKey, transcribedCount, failedCount, skippedTooLarge } = input;
    if (transcribedCount > 0) {
      this.counters.audioTranscribed += transcribedCount;
      this.pushEvent(requestId, sessionKey, "audio.transcribed", `count=${transcribedCount}`);
    }
    if (failedCount > 0) {
      this.counters.audioFailed += failedCount;
      this.pushEvent(requestId, sessionKey, "audio.failed", `count=${failedCount}`);
    }
    if (skippedTooLarge > 0) {
      this.counters.audioSkippedTooLarge += skippedTooLarge;
      this.pushEvent(requestId, sessionKey, "audio.skipped_size", `count=${skippedTooLarge}`);
    }
  }

  recordClaudeImageFallback(
    status: "triggered" | "succeeded" | "failed",
    input: { requestId: string; sessionKey: string; detail: string },
  ): void {
    if (status === "triggered") {
      this.counters.claudeImageFallbackTriggered += 1;
      this.pushEvent(input.requestId, input.sessionKey, "claude.image_fallback_triggered", input.detail);
      return;
    }
    if (status === "succeeded") {
      this.counters.claudeImageFallbackSucceeded += 1;
      this.pushEvent(input.requestId, input.sessionKey, "claude.image_fallback_succeeded", input.detail);
      return;
    }
    this.counters.claudeImageFallbackFailed += 1;
    this.pushEvent(input.requestId, input.sessionKey, "claude.image_fallback_failed", input.detail);
  }

  snapshot(limit = 10): { counters: MediaMetricCounters; recentEvents: MediaMetricEvent[] } {
    const safeLimit = Math.max(1, Math.floor(limit));
    return {
      counters: { ...this.counters },
      recentEvents: this.events.slice(Math.max(0, this.events.length - safeLimit)).reverse(),
    };
  }

  listEventsByRequestId(requestId: string, limit = 10): MediaMetricEvent[] {
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) {
      return [];
    }
    const safeLimit = Math.max(1, Math.floor(limit));
    return this.events
      .filter((event) => event.requestId === normalizedRequestId)
      .slice(-safeLimit)
      .reverse();
  }

  private pushEvent(requestId: string, sessionKey: string, type: string, detail: string): void {
    this.events.push({
      at: new Date().toISOString(),
      type,
      requestId,
      sessionKey,
      detail,
    });
    if (this.events.length <= this.maxEvents) {
      return;
    }
    this.events.splice(0, this.events.length - this.maxEvents);
  }
}
