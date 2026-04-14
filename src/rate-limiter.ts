export interface RateLimiterOptions {
  windowMs: number;
  maxRequestsPerUser: number;
  maxRequestsPerRoom: number;
  maxConcurrentGlobal: number;
  maxConcurrentPerUser: number;
  maxConcurrentPerRoom: number;
}

export interface SharedRateLimiterOptions {
  mode: "local" | "redis";
  redisUrl: string | null;
  redisKeyPrefix: string;
  redisCommandTimeoutMs: number;
  redisConcurrencyTtlMs: number;
  fallbackToLocal: boolean;
}

export type RateLimitReason =
  | "user_requests_per_window"
  | "room_requests_per_window"
  | "global_concurrency"
  | "user_concurrency"
  | "room_concurrency";

export type RateLimiterDecisionSource = "local" | "shared" | "shared_fallback";
export type RateLimiterDecisionOutcome = "allowed" | "denied" | "shared_error";

export interface RateLimiterDecisionRecord {
  at: string;
  source: RateLimiterDecisionSource;
  outcome: RateLimiterDecisionOutcome;
  reason: RateLimitReason | "shared_backend_error" | null;
  retryAfterMs: number | null;
}

export interface RateLimitDecision {
  allowed: boolean;
  reason?: RateLimitReason;
  retryAfterMs?: number;
  release?: () => void;
}

export interface RateLimiterSnapshot {
  activeGlobal: number;
  activeUsers: number;
  activeRooms: number;
  sharedMode: SharedRateLimiterOptions["mode"];
  sharedBackendEnabled: boolean;
  fallbackToLocal: boolean;
  decisionsTotal: number;
  allowedTotal: number;
  deniedTotal: number;
  rejectionRate: number;
  decisionBreakdown: {
    local: {
      allowed: number;
      denied: number;
    };
    shared: {
      allowed: number;
      denied: number;
      errors: number;
    };
    sharedFallback: {
      allowed: number;
      denied: number;
    };
  };
  deniedByReason: Record<RateLimitReason, number>;
  recovery: {
    count: number;
    lastMs: number;
    avgMs: number;
    pendingSinceIso: string | null;
    pendingForMs: number;
  };
  recent: RateLimiterDecisionRecord[];
}

export interface AcquireParams {
  userId: string;
  roomId: string;
}

export interface RateLimiterLike {
  updateOptions(next: RateLimiterOptions): void;
  getOptions(): RateLimiterOptions;
  tryAcquire(params: AcquireParams, now?: number): RateLimitDecision | Promise<RateLimitDecision>;
  snapshot(): RateLimiterSnapshot;
}

export interface SharedRateLimiterDecision {
  allowed: boolean;
  reason?: RateLimitReason;
  retryAfterMs?: number;
}

export interface SharedRateLimiterBackend {
  tryAcquire(input: { params: AcquireParams; now: number; options: RateLimiterOptions }): Promise<SharedRateLimiterDecision>;
  release(input: { params: AcquireParams; now: number; options: RateLimiterOptions }): Promise<void>;
  updateOptions?(options: RateLimiterOptions): void;
}

interface RateLimiterRuntimeOptions {
  sharedBackend?: SharedRateLimiterBackend | null;
  fallbackToLocal?: boolean;
  sharedMode?: SharedRateLimiterOptions["mode"];
  decisionHistoryMax?: number;
}

export class RateLimiter implements RateLimiterLike {
  private options: RateLimiterOptions;
  private readonly userRequests = new Map<string, number[]>();
  private readonly roomRequests = new Map<string, number[]>();
  private readonly userConcurrent = new Map<string, number>();
  private readonly roomConcurrent = new Map<string, number>();
  private globalConcurrent = 0;
  private readonly sharedBackend: SharedRateLimiterBackend | null;
  private readonly fallbackToLocal: boolean;
  private readonly sharedMode: SharedRateLimiterOptions["mode"];
  private readonly decisionHistoryMax: number;
  private readonly decisionHistory: RateLimiterDecisionRecord[] = [];
  private decisionsTotal = 0;
  private allowedTotal = 0;
  private deniedTotal = 0;
  private localAllowed = 0;
  private localDenied = 0;
  private sharedAllowed = 0;
  private sharedDenied = 0;
  private sharedErrors = 0;
  private sharedFallbackAllowed = 0;
  private sharedFallbackDenied = 0;
  private recoveryCount = 0;
  private recoveryTotalMs = 0;
  private recoveryLastMs = 0;
  private recoveryPendingSinceMs: number | null = null;
  private readonly deniedByReason: Record<RateLimitReason, number> = {
    user_requests_per_window: 0,
    room_requests_per_window: 0,
    global_concurrency: 0,
    user_concurrency: 0,
    room_concurrency: 0,
  };

  constructor(options: RateLimiterOptions, runtimeOptions: RateLimiterRuntimeOptions = {}) {
    this.options = normalizeRateLimiterOptions(options);
    this.sharedBackend = runtimeOptions.sharedBackend ?? null;
    this.fallbackToLocal = runtimeOptions.fallbackToLocal ?? true;
    if (runtimeOptions.sharedMode === "redis" || runtimeOptions.sharedMode === "local") {
      this.sharedMode = runtimeOptions.sharedMode;
    } else {
      this.sharedMode = this.sharedBackend ? "redis" : "local";
    }
    this.decisionHistoryMax =
      typeof runtimeOptions.decisionHistoryMax === "number" && Number.isFinite(runtimeOptions.decisionHistoryMax)
        ? Math.max(20, Math.floor(runtimeOptions.decisionHistoryMax))
        : 120;
  }

  updateOptions(next: RateLimiterOptions): void {
    this.options = normalizeRateLimiterOptions(next);
    this.sharedBackend?.updateOptions?.(this.options);
  }

  getOptions(): RateLimiterOptions {
    return { ...this.options };
  }

  tryAcquire(params: AcquireParams, now = Date.now()): RateLimitDecision | Promise<RateLimitDecision> {
    if (!this.sharedBackend) {
      return this.tryAcquireLocal(params, now, "local");
    }
    return this.tryAcquireShared(params, now);
  }

  snapshot(): RateLimiterSnapshot {
    const now = Date.now();
    const pendingForMs =
      this.recoveryPendingSinceMs === null ? 0 : Math.max(0, now - this.recoveryPendingSinceMs);
    return {
      activeGlobal: this.globalConcurrent,
      activeUsers: this.userConcurrent.size,
      activeRooms: this.roomConcurrent.size,
      sharedMode: this.sharedMode,
      sharedBackendEnabled: Boolean(this.sharedBackend),
      fallbackToLocal: this.fallbackToLocal,
      decisionsTotal: this.decisionsTotal,
      allowedTotal: this.allowedTotal,
      deniedTotal: this.deniedTotal,
      rejectionRate: this.decisionsTotal > 0 ? this.deniedTotal / this.decisionsTotal : 0,
      decisionBreakdown: {
        local: {
          allowed: this.localAllowed,
          denied: this.localDenied,
        },
        shared: {
          allowed: this.sharedAllowed,
          denied: this.sharedDenied,
          errors: this.sharedErrors,
        },
        sharedFallback: {
          allowed: this.sharedFallbackAllowed,
          denied: this.sharedFallbackDenied,
        },
      },
      deniedByReason: { ...this.deniedByReason },
      recovery: {
        count: this.recoveryCount,
        lastMs: this.recoveryLastMs,
        avgMs: this.recoveryCount > 0 ? Math.round(this.recoveryTotalMs / this.recoveryCount) : 0,
        pendingSinceIso: this.recoveryPendingSinceMs === null ? null : new Date(this.recoveryPendingSinceMs).toISOString(),
        pendingForMs,
      },
      recent: [...this.decisionHistory],
    };
  }

  private async tryAcquireShared(params: AcquireParams, now: number): Promise<RateLimitDecision> {
    try {
      const sharedDecision = await this.sharedBackend!.tryAcquire({
        params,
        now,
        options: this.options,
      });
      if (!sharedDecision.allowed) {
        this.recordDenied({
          source: "shared",
          now,
          reason: sharedDecision.reason ?? "global_concurrency",
          retryAfterMs: sharedDecision.retryAfterMs,
        });
        return {
          allowed: false,
          reason: sharedDecision.reason,
          retryAfterMs: sharedDecision.retryAfterMs,
        };
      }

      this.recordRequestWindowHit(this.userRequests, params.userId, now);
      this.recordRequestWindowHit(this.roomRequests, params.roomId, now);
      this.incrementConcurrency(params);
      this.recordAllowed({
        source: "shared",
        now,
      });
      let released = false;
      return {
        allowed: true,
        release: () => {
          if (released) {
            return;
          }
          released = true;
          this.decrementConcurrency(params);
          void this.sharedBackend!
            .release({
              params,
              now: Date.now(),
              options: this.options,
            })
            .catch(() => {});
        },
      };
    } catch {
      this.recordSharedError(now);
      if (!this.fallbackToLocal) {
        this.recordDenied({
          source: "shared",
          now,
          reason: "global_concurrency",
          retryAfterMs: this.options.windowMs,
        });
        return {
          allowed: false,
          reason: "global_concurrency",
          retryAfterMs: this.options.windowMs,
        };
      }
      return this.tryAcquireLocal(params, now, "shared_fallback");
    }
  }

  private tryAcquireLocal(
    params: AcquireParams,
    now = Date.now(),
    source: RateLimiterDecisionSource = "local",
  ): RateLimitDecision {
    const userTimestamps = this.pruneAndGetWindow(this.userRequests, params.userId, now);
    if (
      this.options.maxRequestsPerUser > 0 &&
      userTimestamps.length >= this.options.maxRequestsPerUser
    ) {
      const retryAfterMs = computeRetryAfter(userTimestamps, this.options.windowMs, now);
      this.recordDenied({
        source,
        now,
        reason: "user_requests_per_window",
        retryAfterMs,
      });
      return {
        allowed: false,
        reason: "user_requests_per_window",
        retryAfterMs,
      };
    }

    const roomTimestamps = this.pruneAndGetWindow(this.roomRequests, params.roomId, now);
    if (
      this.options.maxRequestsPerRoom > 0 &&
      roomTimestamps.length >= this.options.maxRequestsPerRoom
    ) {
      const retryAfterMs = computeRetryAfter(roomTimestamps, this.options.windowMs, now);
      this.recordDenied({
        source,
        now,
        reason: "room_requests_per_window",
        retryAfterMs,
      });
      return {
        allowed: false,
        reason: "room_requests_per_window",
        retryAfterMs,
      };
    }

    if (this.options.maxConcurrentGlobal > 0 && this.globalConcurrent >= this.options.maxConcurrentGlobal) {
      this.recordDenied({
        source,
        now,
        reason: "global_concurrency",
      });
      return {
        allowed: false,
        reason: "global_concurrency",
      };
    }

    const activeForUser = this.userConcurrent.get(params.userId) ?? 0;
    if (this.options.maxConcurrentPerUser > 0 && activeForUser >= this.options.maxConcurrentPerUser) {
      this.recordDenied({
        source,
        now,
        reason: "user_concurrency",
      });
      return {
        allowed: false,
        reason: "user_concurrency",
      };
    }

    const activeForRoom = this.roomConcurrent.get(params.roomId) ?? 0;
    if (this.options.maxConcurrentPerRoom > 0 && activeForRoom >= this.options.maxConcurrentPerRoom) {
      this.recordDenied({
        source,
        now,
        reason: "room_concurrency",
      });
      return {
        allowed: false,
        reason: "room_concurrency",
      };
    }

    userTimestamps.push(now);
    roomTimestamps.push(now);
    this.userRequests.set(params.userId, userTimestamps);
    this.roomRequests.set(params.roomId, roomTimestamps);
    this.globalConcurrent += 1;
    this.userConcurrent.set(params.userId, activeForUser + 1);
    this.roomConcurrent.set(params.roomId, activeForRoom + 1);
    this.recordAllowed({
      source,
      now,
    });

    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.globalConcurrent = Math.max(0, this.globalConcurrent - 1);
        this.decrementCounter(this.userConcurrent, params.userId);
        this.decrementCounter(this.roomConcurrent, params.roomId);
      },
    };
  }

  private recordRequestWindowHit(container: Map<string, number[]>, key: string, now: number): void {
    const window = this.pruneAndGetWindow(container, key, now);
    window.push(now);
    container.set(key, window);
  }

  private incrementConcurrency(params: AcquireParams): void {
    this.globalConcurrent += 1;
    this.userConcurrent.set(params.userId, (this.userConcurrent.get(params.userId) ?? 0) + 1);
    this.roomConcurrent.set(params.roomId, (this.roomConcurrent.get(params.roomId) ?? 0) + 1);
  }

  private decrementConcurrency(params: AcquireParams): void {
    this.globalConcurrent = Math.max(0, this.globalConcurrent - 1);
    this.decrementCounter(this.userConcurrent, params.userId);
    this.decrementCounter(this.roomConcurrent, params.roomId);
  }

  private pruneAndGetWindow(container: Map<string, number[]>, key: string, now: number): number[] {
    const existing = container.get(key);
    if (!existing) {
      return [];
    }
    const threshold = now - this.options.windowMs;
    let writeIndex = 0;
    for (let readIndex = 0; readIndex < existing.length; readIndex += 1) {
      const timestamp = existing[readIndex];
      if (timestamp > threshold) {
        existing[writeIndex] = timestamp;
        writeIndex += 1;
      }
    }

    if (writeIndex === 0) {
      container.delete(key);
      return [];
    }

    existing.length = writeIndex;
    return existing;
  }

  private decrementCounter(container: Map<string, number>, key: string): void {
    const current = container.get(key) ?? 0;
    if (current <= 1) {
      container.delete(key);
      return;
    }
    container.set(key, current - 1);
  }

  private recordAllowed(input: { source: RateLimiterDecisionSource; now: number }): void {
    this.decisionsTotal += 1;
    this.allowedTotal += 1;
    if (input.source === "local") {
      this.localAllowed += 1;
    } else if (input.source === "shared") {
      this.sharedAllowed += 1;
    } else {
      this.sharedFallbackAllowed += 1;
    }
    if (this.recoveryPendingSinceMs !== null && input.now >= this.recoveryPendingSinceMs) {
      const durationMs = input.now - this.recoveryPendingSinceMs;
      this.recoveryCount += 1;
      this.recoveryTotalMs += durationMs;
      this.recoveryLastMs = durationMs;
      this.recoveryPendingSinceMs = null;
    }
    this.pushDecisionRecord({
      at: new Date(input.now).toISOString(),
      source: input.source,
      outcome: "allowed",
      reason: null,
      retryAfterMs: null,
    });
  }

  private recordDenied(input: {
    source: RateLimiterDecisionSource;
    now: number;
    reason: RateLimitReason;
    retryAfterMs?: number;
  }): void {
    this.decisionsTotal += 1;
    this.deniedTotal += 1;
    this.deniedByReason[input.reason] += 1;
    if (input.source === "local") {
      this.localDenied += 1;
    } else if (input.source === "shared") {
      this.sharedDenied += 1;
    } else {
      this.sharedFallbackDenied += 1;
    }
    if (this.recoveryPendingSinceMs === null) {
      this.recoveryPendingSinceMs = input.now;
    }
    this.pushDecisionRecord({
      at: new Date(input.now).toISOString(),
      source: input.source,
      outcome: "denied",
      reason: input.reason,
      retryAfterMs: typeof input.retryAfterMs === "number" ? Math.max(0, input.retryAfterMs) : null,
    });
  }

  private recordSharedError(now: number): void {
    this.sharedErrors += 1;
    this.pushDecisionRecord({
      at: new Date(now).toISOString(),
      source: "shared",
      outcome: "shared_error",
      reason: "shared_backend_error",
      retryAfterMs: null,
    });
  }

  private pushDecisionRecord(record: RateLimiterDecisionRecord): void {
    this.decisionHistory.push(record);
    if (this.decisionHistory.length <= this.decisionHistoryMax) {
      return;
    }
    this.decisionHistory.splice(0, this.decisionHistory.length - this.decisionHistoryMax);
  }
}

function computeRetryAfter(timestamps: number[], windowMs: number, now: number): number {
  const oldest = timestamps[0];
  if (typeof oldest !== "number") {
    return windowMs;
  }
  return Math.max(0, oldest + windowMs - now);
}

function normalizeRateLimiterOptions(options: RateLimiterOptions): RateLimiterOptions {
  return {
    windowMs: normalizeInteger(options.windowMs, 1, "windowMs"),
    maxRequestsPerUser: normalizeInteger(options.maxRequestsPerUser, 0, "maxRequestsPerUser"),
    maxRequestsPerRoom: normalizeInteger(options.maxRequestsPerRoom, 0, "maxRequestsPerRoom"),
    maxConcurrentGlobal: normalizeInteger(options.maxConcurrentGlobal, 0, "maxConcurrentGlobal"),
    maxConcurrentPerUser: normalizeInteger(options.maxConcurrentPerUser, 0, "maxConcurrentPerUser"),
    maxConcurrentPerRoom: normalizeInteger(options.maxConcurrentPerRoom, 0, "maxConcurrentPerRoom"),
  };
}

function normalizeInteger(value: number, min: number, field: keyof RateLimiterOptions): number {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`Invalid rate limiter option "${field}": expected integer >= ${min}.`);
  }
  return value;
}
