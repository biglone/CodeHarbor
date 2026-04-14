import { describe, expect, it, vi } from "vitest";

import { RateLimiter, type SharedRateLimiterBackend } from "../src/rate-limiter";

function createOptions() {
  return {
    windowMs: 60_000,
    maxRequestsPerUser: 20,
    maxRequestsPerRoom: 120,
    maxConcurrentGlobal: 2,
    maxConcurrentPerUser: 2,
    maxConcurrentPerRoom: 2,
  };
}

describe("RateLimiter shared backend integration", () => {
  it("uses shared backend denial directly", async () => {
    const backend: SharedRateLimiterBackend = {
      tryAcquire: vi.fn(async () => ({
        allowed: false,
        reason: "global_concurrency" as const,
      })),
      release: vi.fn(async () => {}),
    };
    const limiter = new RateLimiter(createOptions(), {
      sharedBackend: backend,
      fallbackToLocal: true,
    });

    const decision = await Promise.resolve(
      limiter.tryAcquire({
        userId: "@alice:example.com",
        roomId: "!room:example.com",
      }),
    );

    expect(decision).toEqual({
      allowed: false,
      reason: "global_concurrency",
      retryAfterMs: undefined,
    });
    expect(backend.release).toHaveBeenCalledTimes(0);
  });

  it("releases shared concurrency slot after allowed acquire", async () => {
    const release = vi.fn(async () => {});
    const backend: SharedRateLimiterBackend = {
      tryAcquire: vi.fn(async () => ({
        allowed: true,
      })),
      release,
    };
    const limiter = new RateLimiter(createOptions(), {
      sharedBackend: backend,
      fallbackToLocal: true,
    });

    const decision = await Promise.resolve(
      limiter.tryAcquire({
        userId: "@alice:example.com",
        roomId: "!room:example.com",
      }),
    );
    expect(decision.allowed).toBe(true);
    expect(limiter.snapshot().activeGlobal).toBe(1);
    decision.release?.();
    await Promise.resolve();

    expect(release).toHaveBeenCalledTimes(1);
    expect(limiter.snapshot().activeGlobal).toBe(0);
  });

  it("falls back to local limiter when shared backend fails", async () => {
    const backend: SharedRateLimiterBackend = {
      tryAcquire: vi.fn(async () => {
        throw new Error("redis unavailable");
      }),
      release: vi.fn(async () => {}),
    };
    const limiter = new RateLimiter(
      {
        windowMs: 60_000,
        maxRequestsPerUser: 20,
        maxRequestsPerRoom: 120,
        maxConcurrentGlobal: 1,
        maxConcurrentPerUser: 1,
        maxConcurrentPerRoom: 1,
      },
      {
        sharedBackend: backend,
        fallbackToLocal: true,
      },
    );

    const first = await Promise.resolve(
      limiter.tryAcquire({
        userId: "@alice:example.com",
        roomId: "!room:example.com",
      }),
    );
    expect(first.allowed).toBe(true);

    const second = await Promise.resolve(
      limiter.tryAcquire({
        userId: "@alice:example.com",
        roomId: "!room:example.com",
      }),
    );
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe("global_concurrency");

    first.release?.();
    const third = await Promise.resolve(
      limiter.tryAcquire({
        userId: "@alice:example.com",
        roomId: "!room:example.com",
      }),
    );
    expect(third.allowed).toBe(true);
  });

  it("denies request when shared backend fails and fallback is disabled", async () => {
    const backend: SharedRateLimiterBackend = {
      tryAcquire: vi.fn(async () => {
        throw new Error("redis unavailable");
      }),
      release: vi.fn(async () => {}),
    };
    const limiter = new RateLimiter(createOptions(), {
      sharedBackend: backend,
      fallbackToLocal: false,
    });

    const decision = await Promise.resolve(
      limiter.tryAcquire({
        userId: "@alice:example.com",
        roomId: "!room:example.com",
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("global_concurrency");
    expect((decision.retryAfterMs ?? 0) > 0).toBe(true);
  });

  it("tracks rejection counters and recovery duration in local mode", async () => {
    const limiter = new RateLimiter({
      windowMs: 60_000,
      maxRequestsPerUser: 1,
      maxRequestsPerRoom: 100,
      maxConcurrentGlobal: 5,
      maxConcurrentPerUser: 5,
      maxConcurrentPerRoom: 5,
    });

    const first = await Promise.resolve(
      limiter.tryAcquire(
        {
          userId: "@alice:example.com",
          roomId: "!room:example.com",
        },
        1_000,
      ),
    );
    expect(first.allowed).toBe(true);
    first.release?.();
    const denied = await Promise.resolve(
      limiter.tryAcquire(
        {
          userId: "@alice:example.com",
          roomId: "!room:example.com",
        },
        1_001,
      ),
    );
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("user_requests_per_window");

    const recovered = await Promise.resolve(
      limiter.tryAcquire(
        {
          userId: "@alice:example.com",
          roomId: "!room:example.com",
        },
        61_100,
      ),
    );
    expect(recovered.allowed).toBe(true);
    recovered.release?.();

    const snapshot = limiter.snapshot();
    expect(snapshot.decisionsTotal).toBe(3);
    expect(snapshot.allowedTotal).toBe(2);
    expect(snapshot.deniedTotal).toBe(1);
    expect(snapshot.deniedByReason.user_requests_per_window).toBe(1);
    expect(snapshot.recovery.count).toBe(1);
    expect(snapshot.recovery.lastMs).toBe(60_099);
    expect(snapshot.recovery.avgMs).toBe(60_099);
    expect(snapshot.recent.length).toBe(3);
  });

  it("counts shared backend errors and fallback decisions", async () => {
    let attempt = 0;
    const backend: SharedRateLimiterBackend = {
      tryAcquire: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("redis unavailable");
        }
        return {
          allowed: true,
        };
      }),
      release: vi.fn(async () => {}),
    };
    const limiter = new RateLimiter(createOptions(), {
      sharedBackend: backend,
      fallbackToLocal: true,
    });

    const first = await Promise.resolve(
      limiter.tryAcquire({
        userId: "@alice:example.com",
        roomId: "!room:example.com",
      }),
    );
    expect(first.allowed).toBe(true);
    first.release?.();

    const second = await Promise.resolve(
      limiter.tryAcquire({
        userId: "@alice:example.com",
        roomId: "!room:example.com",
      }),
    );
    expect(second.allowed).toBe(true);
    second.release?.();

    const snapshot = limiter.snapshot();
    expect(snapshot.decisionBreakdown.shared.errors).toBe(1);
    expect(snapshot.decisionBreakdown.sharedFallback.allowed).toBe(1);
    expect(snapshot.decisionBreakdown.shared.allowed).toBe(1);
    expect(snapshot.decisionsTotal).toBe(2);
    expect(snapshot.sharedMode).toBe("redis");
  });
});
