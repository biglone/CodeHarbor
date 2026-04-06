import { describe, expect, it } from "vitest";

import { dispatchAutoDevCommandWithRegistry } from "../src/orchestrator/autodev-command-handler-registry";
import type { InboundMessage } from "../src/types";
import type { AutoDevCommand } from "../src/workflow/autodev";

function createMessage(text: string): InboundMessage {
  return {
    requestId: "request-1",
    channel: "matrix",
    conversationId: "conversation-1",
    senderId: "user-1",
    eventId: `event-${Date.now()}`,
    text,
    attachments: [],
    isDirectMessage: true,
    mentionsBot: false,
    repliesToBot: false,
  };
}

describe("autodev command handler registry", () => {
  it("dispatches run/status/stop/progress/content handlers by kind", async () => {
    const calls: string[] = [];
    const context = {
      sessionKey: "session-1",
      message: createMessage("/autodev"),
      workdir: "/tmp/workdir",
    };

    const commands: AutoDevCommand[] = [
      { kind: "run", taskId: "T10.7" },
      { kind: "status" },
      { kind: "stop" },
      { kind: "progress", mode: "on" },
      { kind: "content", mode: "off" },
    ];

    const registry = {
      run: async (command: Extract<AutoDevCommand, { kind: "run" }>) => {
        calls.push(`run:${command.taskId}`);
      },
      status: async () => {
        calls.push("status");
      },
      stop: async () => {
        calls.push("stop");
      },
      progress: async (command: Extract<AutoDevCommand, { kind: "progress" }>) => {
        calls.push(`progress:${command.mode}`);
      },
      content: async (command: Extract<AutoDevCommand, { kind: "content" }>) => {
        calls.push(`content:${command.mode}`);
      },
    };

    for (const command of commands) {
      const dispatched = await dispatchAutoDevCommandWithRegistry(command, registry, context);
      expect(dispatched.handled).toBe(true);
      expect(dispatched.routeLabel).toBe(`autodev.${command.kind}`);
    }

    expect(calls).toEqual(["run:T10.7", "status", "stop", "progress:on", "content:off"]);
  });

  it("returns unhandled when command has no registered handler", async () => {
    const dispatched = await dispatchAutoDevCommandWithRegistry(
      { kind: "skills", mode: "full" },
      {
        status: async () => {},
      },
      {
        sessionKey: "session-2",
        message: createMessage("/autodev skills full"),
        workdir: "/tmp/workdir",
      },
    );

    expect(dispatched).toEqual({ handled: false, routeLabel: null });
  });

  it("returns unhandled for null command", async () => {
    const dispatched = await dispatchAutoDevCommandWithRegistry(
      null,
      {
        status: async () => {},
      },
      {
        sessionKey: "session-3",
        message: createMessage("hello"),
        workdir: "/tmp/workdir",
      },
    );

    expect(dispatched).toEqual({ handled: false, routeLabel: null });
  });
});
