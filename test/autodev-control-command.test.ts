import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { OutputLanguage } from "../src/config";
import {
  handleAutoDevInitCommand,
  handleAutoDevWorkdirCommand,
  type AutoDevControlCommandDeps,
} from "../src/orchestrator/autodev-control-command";
import type { InboundMessage } from "../src/types";

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

function createDeps(options?: { outputLanguage?: OutputLanguage }) {
  const notices: string[] = [];
  const overrides = new Map<string, string>();
  const deps: AutoDevControlCommandDeps = {
    autoDevDetailedProgressDefaultEnabled: true,
    outputLanguage: options?.outputLanguage ?? "en",
    pendingAutoDevLoopStopRequests: new Set<string>(),
    activeAutoDevLoopSessions: new Set<string>(),
    isAutoDevDetailedProgressEnabled: () => true,
    setAutoDevDetailedProgressEnabled: () => {},
    setWorkflowRoleSkillPolicyOverride: () => {},
    buildWorkflowRoleSkillStatus: () => ({
      enabled: true,
      mode: "progressive",
      maxChars: 2400,
      override: "none",
      roots: "/home/user/.codex/skills",
      loaded: "planner=builtin-planner-core",
    }),
    getAutoDevWorkdirOverride: (sessionKey) => overrides.get(sessionKey) ?? null,
    setAutoDevWorkdirOverride: (sessionKey, workdir) => {
      overrides.set(sessionKey, workdir);
    },
    clearAutoDevWorkdirOverride: (sessionKey) => {
      overrides.delete(sessionKey);
    },
    sendNotice: async (_conversationId, text) => {
      notices.push(text);
    },
  };
  return { deps, notices, overrides };
}

describe("AutoDev control command helpers", () => {
  it("initializes task compass files and sets workdir override", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-init-"));
    const { deps, notices, overrides } = createDeps();
    try {
      await handleAutoDevInitCommand(deps, {
        sessionKey: "session-1",
        message: createMessage("/autodev init"),
        path: tempRoot,
        skill: "requirements-doc",
        roomWorkdir: "/home/fallback",
      });

      const requirementsPath = path.join(tempRoot, "REQUIREMENTS.md");
      const taskListPath = path.join(tempRoot, "TASK_LIST.md");
      const compassPath = path.join(tempRoot, "docs", "AUTODEV_TASK_COMPASS.md");
      await expect(fs.access(requirementsPath)).resolves.toBeUndefined();
      await expect(fs.access(taskListPath)).resolves.toBeUndefined();
      await expect(fs.access(compassPath)).resolves.toBeUndefined();
      const requirementsText = await fs.readFile(requirementsPath, "utf8");
      expect(requirementsText.includes("Preferred skill")).toBe(false);
      expect(overrides.get("session-1")).toBe(path.resolve(tempRoot));
      expect(notices.at(-1)).toContain("AutoDev task compass is ready");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("sets and clears AutoDev workdir override", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-workdir-"));
    const { deps, notices, overrides } = createDeps();
    try {
      await handleAutoDevWorkdirCommand(deps, {
        sessionKey: "session-2",
        message: createMessage("/autodev workdir"),
        mode: "set",
        path: tempRoot,
        roomWorkdir: "/home/default",
      });
      expect(overrides.get("session-2")).toBe(path.resolve(tempRoot));
      expect(notices.at(-1)).toContain("AutoDev workdir updated");

      await handleAutoDevWorkdirCommand(deps, {
        sessionKey: "session-2",
        message: createMessage("/autodev workdir clear"),
        mode: "clear",
        path: null,
        roomWorkdir: "/home/default",
      });
      expect(overrides.has("session-2")).toBe(false);
      expect(notices.at(-1)).toContain("Cleared AutoDev workdir override");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("resolves sibling workspace project by short project name", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-workspace-"));
    const roomWorkdir = path.join(workspaceRoot, "CodeHarbor");
    const siblingProject = path.join(workspaceRoot, "StrawBerry");
    await fs.mkdir(roomWorkdir, { recursive: true });
    await fs.mkdir(siblingProject, { recursive: true });

    const { deps, overrides } = createDeps();
    try {
      await handleAutoDevInitCommand(deps, {
        sessionKey: "session-3",
        message: createMessage("/autodev init StrawBerry"),
        path: "StrawBerry",
        skill: null,
        roomWorkdir,
      });
      expect(overrides.get("session-3")).toBe(path.resolve(siblingProject));
      await expect(fs.access(path.join(siblingProject, "TASK_LIST.md"))).resolves.toBeUndefined();
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
