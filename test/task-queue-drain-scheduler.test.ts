import { afterEach, describe, expect, it, vi } from "vitest";

import {
  reconcileSessionQueueDrain,
  scheduleSessionQueueDrainAtNextRetry,
  startSessionQueueDrain,
} from "../src/orchestrator/task-queue-drain-scheduler";

function createLoggerStub() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("task queue drain scheduler", () => {
  it("keeps a consistent timestamp snapshot when startSessionQueueDrain defers to retry schedule", () => {
    const scheduleFn = vi.fn();
    const queueStore = {
      hasReadyTask: vi.fn((_sessionKey: string, now = Date.now()) => now >= 101),
      getNextPendingRetryAt: vi.fn((_sessionKey: string, now = Date.now()) => (now < 101 ? 101 : null)),
    };
    vi.spyOn(Date, "now")
      .mockImplementationOnce(() => 100)
      .mockImplementation(() => 101);

    startSessionQueueDrain(
      {
        sessionQueueDrains: new Map<string, Promise<void>>(),
        getTaskQueueStateStore: () => queueStore,
        clearSessionQueueRetryTimer: vi.fn(),
        scheduleSessionQueueDrainAtNextRetry: (sessionKey, store, now) =>
          scheduleSessionQueueDrainAtNextRetry(scheduleFn, sessionKey, store, now),
        drainSessionQueue: vi.fn(async () => {}),
        reconcileSessionQueueDrain: vi.fn(),
        logger: createLoggerStub() as never,
      },
      "session-1",
    );

    expect(queueStore.hasReadyTask).toHaveBeenCalledWith("session-1", 100);
    expect(queueStore.getNextPendingRetryAt).toHaveBeenCalledWith("session-1", 100);
    expect(scheduleFn).toHaveBeenCalledWith("session-1", 101);
  });

  it("keeps a consistent timestamp snapshot when reconcileSessionQueueDrain defers to retry schedule", () => {
    const scheduleFn = vi.fn();
    const queueStore = {
      hasReadyTask: vi.fn((_sessionKey: string, now = Date.now()) => now >= 201),
      getNextPendingRetryAt: vi.fn((_sessionKey: string, now = Date.now()) => (now < 201 ? 201 : null)),
    };
    vi.spyOn(Date, "now")
      .mockImplementationOnce(() => 200)
      .mockImplementation(() => 201);

    reconcileSessionQueueDrain(
      {
        getTaskQueueStateStore: () => queueStore,
        startSessionQueueDrain: vi.fn(),
        scheduleSessionQueueDrainAtNextRetry: (sessionKey, store, now) =>
          scheduleSessionQueueDrainAtNextRetry(scheduleFn, sessionKey, store, now),
        logger: createLoggerStub() as never,
      },
      "session-2",
    );

    expect(queueStore.hasReadyTask).toHaveBeenCalledWith("session-2", 200);
    expect(queueStore.getNextPendingRetryAt).toHaveBeenCalledWith("session-2", 200);
    expect(scheduleFn).toHaveBeenCalledWith("session-2", 201);
  });
});
