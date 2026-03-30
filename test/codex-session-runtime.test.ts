import { describe, expect, it, vi } from "vitest";

import { CodexSessionRuntime } from "../src/executor/codex-session-runtime";

class FakeExecutor {
  calls: Array<{ prompt: string; sessionId: string | null; workdir: string | null }> = [];
  private counter = 0;

  startExecution(
    prompt: string,
    sessionId: string | null,
    _onProgress?: (event: unknown) => void,
    startOptions?: { workdir?: string },
  ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } {
    this.calls.push({
      prompt,
      sessionId,
      workdir: startOptions?.workdir ?? null,
    });
    this.counter += 1;
    const nextSessionId = sessionId ?? `thread-${this.counter}`;
    return {
      result: Promise.resolve({ sessionId: nextSessionId, reply: "ok" }),
      cancel: vi.fn(),
    };
  }
}

class ResumeFailingExecutor {
  calls: Array<{ prompt: string; sessionId: string | null; workdir: string | null }> = [];

  startExecution(
    prompt: string,
    sessionId: string | null,
    _onProgress?: (event: unknown) => void,
    startOptions?: { workdir?: string },
  ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } {
    this.calls.push({
      prompt,
      sessionId,
      workdir: startOptions?.workdir ?? null,
    });
    if (sessionId) {
      return {
        result: Promise.reject(
          new Error(
            `gemini exited with code 42: Error resuming session: Invalid session identifier "${sessionId}". Use --list-sessions to see available sessions.`,
          ),
        ),
        cancel: vi.fn(),
      };
    }
    return {
      result: Promise.resolve({ sessionId: "gem-new-session", reply: "ok" }),
      cancel: vi.fn(),
    };
  }
}

class GenericFailingExecutor {
  calls: Array<{ prompt: string; sessionId: string | null; workdir: string | null }> = [];

  startExecution(
    prompt: string,
    sessionId: string | null,
    _onProgress?: (event: unknown) => void,
    startOptions?: { workdir?: string },
  ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } {
    this.calls.push({
      prompt,
      sessionId,
      workdir: startOptions?.workdir ?? null,
    });
    return {
      result: Promise.reject(new Error("network unavailable")),
      cancel: vi.fn(),
    };
  }
}

describe("CodexSessionRuntime", () => {
  it("reuses last session id across executions within same session key", async () => {
    const executor = new FakeExecutor();
    const runtime = new CodexSessionRuntime(executor as never, { idleTtlMs: 60_000 });

    const first = runtime.startExecution("matrix:room:user", "hello", null);
    await expect(first.result).resolves.toMatchObject({ sessionId: "thread-1" });

    const second = runtime.startExecution("matrix:room:user", "follow", null);
    await expect(second.result).resolves.toMatchObject({ sessionId: "thread-1" });

    expect(executor.calls).toEqual([
      { prompt: "hello", sessionId: null, workdir: null },
      { prompt: "follow", sessionId: "thread-1", workdir: null },
    ]);
  });

  it("tracks worker stats and clearSession", async () => {
    const executor = new FakeExecutor();
    const runtime = new CodexSessionRuntime(executor as never, { idleTtlMs: 60_000 });

    await runtime.startExecution("matrix:r:u", "hello", null).result;
    expect(runtime.getRuntimeStats().workerCount).toBe(1);

    runtime.clearSession("matrix:r:u");
    await runtime.startExecution("matrix:r:u", "again", null).result;

    expect(executor.calls[1]?.sessionId).toBeNull();
  });

  it("forwards execution options to executor", async () => {
    const executor = new FakeExecutor();
    const runtime = new CodexSessionRuntime(executor as never, { idleTtlMs: 60_000 });

    await runtime.startExecution("matrix:r:u", "hello", null, undefined, { workdir: "/tmp/project-z" }).result;

    expect(executor.calls).toEqual([
      { prompt: "hello", sessionId: null, workdir: "/tmp/project-z" },
    ]);
  });

  it("retries once without session when resume identifier is invalid", async () => {
    const executor = new ResumeFailingExecutor();
    const runtime = new CodexSessionRuntime(executor as never, { idleTtlMs: 60_000 });

    const handle = runtime.startExecution("matrix:r:u", "hello", "old-session-id");
    await expect(handle.result).resolves.toMatchObject({ sessionId: "gem-new-session", reply: "ok" });

    expect(executor.calls).toEqual([
      { prompt: "hello", sessionId: "old-session-id", workdir: null },
      { prompt: "hello", sessionId: null, workdir: null },
    ]);
  });

  it("does not retry for non-resume failures", async () => {
    const executor = new GenericFailingExecutor();
    const runtime = new CodexSessionRuntime(executor as never, { idleTtlMs: 60_000 });

    const handle = runtime.startExecution("matrix:r:u", "hello", "old-session-id");
    await expect(handle.result).rejects.toThrow("network unavailable");

    expect(executor.calls).toEqual([
      { prompt: "hello", sessionId: "old-session-id", workdir: null },
    ]);
  });
});
