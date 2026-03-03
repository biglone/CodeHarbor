import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { CodexExecutionCancelledError, CodexExecutor } from "../src/executor/codex-executor";

interface FakeChildProcess extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: NodeJS.Signals) => boolean;
}

function createFakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true) as unknown as (signal?: NodeJS.Signals) => boolean;
  return child;
}

describe("CodexExecutor", () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.useRealTimers();
  });

  it("returns thread id and final assistant message", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);
    const progressEvents: Array<{ stage: string; message?: string }> = [];

    const executor = new CodexExecutor({
      bin: "codex",
      model: null,
      workdir: process.cwd(),
      dangerousBypass: false,
      timeoutMs: 1_000,
      sandboxMode: null,
      approvalPolicy: null,
      extraArgs: [],
      extraEnv: {},
    });

    const resultPromise = executor.execute("hello", null, (event) => {
      progressEvents.push(event);
    });
    child.stdout.write('{"type":"thread.started","thread_id":"thread-1"}\n');
    child.stdout.write('{"type":"turn.started"}\n');
    child.stdout.write('{"type":"item.completed","item":{"type":"reasoning","text":"  thinking  "}}\n');
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"  hi there  "}}\n');
    setImmediate(() => child.emit("close", 0));

    await expect(resultPromise).resolves.toEqual({
      sessionId: "thread-1",
      reply: "hi there",
    });
    expect(progressEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "thread_started", message: "thread-1" }),
        expect.objectContaining({ stage: "turn_started" }),
        expect.objectContaining({ stage: "reasoning", message: "thinking" }),
      ]),
    );
  });

  it("throws stderr when codex exits with non-zero code", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);

    const executor = new CodexExecutor({
      bin: "codex",
      model: null,
      workdir: process.cwd(),
      dangerousBypass: false,
      timeoutMs: 1_000,
      sandboxMode: null,
      approvalPolicy: null,
      extraArgs: [],
      extraEnv: {},
    });

    const resultPromise = executor.execute("hello", null);
    child.stderr.write("fatal: boom");
    setImmediate(() => child.emit("close", 2));

    await expect(resultPromise).rejects.toThrow("codex exited with code 2: fatal: boom");
  });

  it("kills process and throws timeout error when execution exceeds limit", async () => {
    vi.useFakeTimers();
    const child = createFakeChildProcess();
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      if (signal === "SIGTERM") {
        child.emit("close", 143);
      }
      return true;
    }) as unknown as (signal?: NodeJS.Signals) => boolean;
    spawnMock.mockReturnValue(child);

    const executor = new CodexExecutor({
      bin: "codex",
      model: null,
      workdir: process.cwd(),
      dangerousBypass: false,
      timeoutMs: 100,
      sandboxMode: null,
      approvalPolicy: null,
      extraArgs: [],
      extraEnv: {},
    });

    const resultPromise = executor.execute("long task", null);
    const assertion = expect(resultPromise).rejects.toThrow("codex execution timed out after 100ms");
    await vi.advanceTimersByTimeAsync(100);

    await assertion;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("supports explicit cancellation through execution handle", async () => {
    const child = createFakeChildProcess();
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      if (signal === "SIGTERM") {
        child.emit("close", 143);
      }
      return true;
    }) as unknown as (signal?: NodeJS.Signals) => boolean;
    spawnMock.mockReturnValue(child);

    const executor = new CodexExecutor({
      bin: "codex",
      model: null,
      workdir: process.cwd(),
      dangerousBypass: false,
      timeoutMs: 1_000,
      sandboxMode: null,
      approvalPolicy: null,
      extraArgs: [],
      extraEnv: {},
    });

    const handle = executor.startExecution("cancel me", null);
    handle.cancel();

    await expect(handle.result).rejects.toBeInstanceOf(CodexExecutionCancelledError);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("emits raw event when passthrough is enabled", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);
    const events: Array<{ stage: string; eventType?: string; message?: string }> = [];

    const executor = new CodexExecutor({
      bin: "codex",
      model: null,
      workdir: process.cwd(),
      dangerousBypass: false,
      timeoutMs: 1_000,
      sandboxMode: null,
      approvalPolicy: null,
      extraArgs: [],
      extraEnv: {},
    });

    const resultPromise = executor.execute(
      "hello",
      null,
      (event) => events.push({ stage: event.stage, eventType: event.eventType, message: event.message }),
      { passThroughRawEvents: true },
    );
    child.stdout.write('{"type":"thread.started","thread_id":"thread-raw"}\n');
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n');
    setImmediate(() => child.emit("close", 0));

    await expect(resultPromise).resolves.toEqual({
      sessionId: "thread-raw",
      reply: "done",
    });
    expect(events.some((event) => event.stage === "raw_event" && event.eventType === "thread.started")).toBe(true);
  });

  it("uses per-request workdir override when provided", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);

    const executor = new CodexExecutor({
      bin: "codex",
      model: null,
      workdir: "/tmp/default-workdir",
      dangerousBypass: false,
      timeoutMs: 1_000,
      sandboxMode: null,
      approvalPolicy: null,
      extraArgs: [],
      extraEnv: {},
    });

    const resultPromise = executor.execute("hello", null, undefined, { workdir: "/tmp/room-workdir" });
    child.stdout.write('{"type":"thread.started","thread_id":"thread-workdir"}\n');
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n');
    setImmediate(() => child.emit("close", 0));

    await expect(resultPromise).resolves.toEqual({
      sessionId: "thread-workdir",
      reply: "done",
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      expect.any(Array),
      expect.objectContaining({
        cwd: "/tmp/room-workdir",
      }),
    );
  });
});
