export interface RateLimiterOptions {
  windowMs: number;
  maxRequestsPerUser: number;
  maxRequestsPerRoom: number;
  maxConcurrentGlobal: number;
  maxConcurrentPerUser: number;
  maxConcurrentPerRoom: number;
}

export type RateLimitReason =
  | "user_requests_per_window"
  | "room_requests_per_window"
  | "global_concurrency"
  | "user_concurrency"
  | "room_concurrency";

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
}

interface AcquireParams {
  userId: string;
  roomId: string;
}

export class RateLimiter {
  private options: RateLimiterOptions;
  private readonly userRequests = new Map<string, number[]>();
  private readonly roomRequests = new Map<string, number[]>();
  private readonly userConcurrent = new Map<string, number>();
  private readonly roomConcurrent = new Map<string, number>();
  private globalConcurrent = 0;

  constructor(options: RateLimiterOptions) {
    this.options = normalizeRateLimiterOptions(options);
  }

  updateOptions(next: RateLimiterOptions): void {
    this.options = normalizeRateLimiterOptions(next);
  }

  getOptions(): RateLimiterOptions {
    return { ...this.options };
  }

  tryAcquire(params: AcquireParams, now = Date.now()): RateLimitDecision {
    const userTimestamps = this.pruneAndGetWindow(this.userRequests, params.userId, now);
    if (
      this.options.maxRequestsPerUser > 0 &&
      userTimestamps.length >= this.options.maxRequestsPerUser
    ) {
      return {
        allowed: false,
        reason: "user_requests_per_window",
        retryAfterMs: computeRetryAfter(userTimestamps, this.options.windowMs, now),
      };
    }

    const roomTimestamps = this.pruneAndGetWindow(this.roomRequests, params.roomId, now);
    if (
      this.options.maxRequestsPerRoom > 0 &&
      roomTimestamps.length >= this.options.maxRequestsPerRoom
    ) {
      return {
        allowed: false,
        reason: "room_requests_per_window",
        retryAfterMs: computeRetryAfter(roomTimestamps, this.options.windowMs, now),
      };
    }

    if (this.options.maxConcurrentGlobal > 0 && this.globalConcurrent >= this.options.maxConcurrentGlobal) {
      return {
        allowed: false,
        reason: "global_concurrency",
      };
    }

    const activeForUser = this.userConcurrent.get(params.userId) ?? 0;
    if (this.options.maxConcurrentPerUser > 0 && activeForUser >= this.options.maxConcurrentPerUser) {
      return {
        allowed: false,
        reason: "user_concurrency",
      };
    }

    const activeForRoom = this.roomConcurrent.get(params.roomId) ?? 0;
    if (this.options.maxConcurrentPerRoom > 0 && activeForRoom >= this.options.maxConcurrentPerRoom) {
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

  snapshot(): RateLimiterSnapshot {
    return {
      activeGlobal: this.globalConcurrent,
      activeUsers: this.userConcurrent.size,
      activeRooms: this.roomConcurrent.size,
    };
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
