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

function createDeps(options?: {
  outputLanguage?: OutputLanguage;
  runAutoDevInitEnhancement?: AutoDevControlCommandDeps["runAutoDevInitEnhancement"];
}) {
  const notices: string[] = [];
  const overrides = new Map<string, string>();
  const deps: AutoDevControlCommandDeps = {
    autoDevDetailedProgressDefaultEnabled: true,
    autoDevStageOutputEchoDefaultEnabled: true,
    outputLanguage: options?.outputLanguage ?? "en",
    pendingAutoDevLoopStopRequests: new Set<string>(),
    activeAutoDevLoopSessions: new Set<string>(),
    isAutoDevDetailedProgressEnabled: () => true,
    setAutoDevDetailedProgressEnabled: () => {},
    isAutoDevStageOutputEchoEnabled: () => true,
    setAutoDevStageOutputEchoEnabled: () => {},
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
    runAutoDevInitEnhancement: options?.runAutoDevInitEnhancement,
    listWorkflowDiagRunsBySession: () => [],
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
        from: null,
        dryRun: false,
        force: false,
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
        from: null,
        dryRun: false,
        force: false,
        roomWorkdir,
      });
      expect(overrides.get("session-3")).toBe(path.resolve(siblingProject));
      await expect(fs.access(path.join(siblingProject, "TASK_LIST.md"))).resolves.toBeUndefined();
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("uses explicit --from document as generation source", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-from-"));
    const docsDir = path.join(tempRoot, "docs");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(
      path.join(docsDir, "技术方案.md"),
      ["# StrawBerry Messaging Platform", "", "## Message Routing", "- must support DM and group", "## Security", "- enforce RBAC"].join("\n"),
      "utf8",
    );

    const { deps } = createDeps();
    try {
      await handleAutoDevInitCommand(deps, {
        sessionKey: "session-4",
        message: createMessage("/autodev init --from docs/技术方案.md"),
        path: tempRoot,
        from: "docs/技术方案.md",
        dryRun: false,
        force: false,
        roomWorkdir: "/home/fallback",
      });

      const requirementsPath = path.join(tempRoot, "REQUIREMENTS.md");
      const requirementsText = await fs.readFile(requirementsPath, "utf8");
      expect(requirementsText).toContain("docs/技术方案.md");
      expect(requirementsText).toContain("StrawBerry Messaging Platform");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("applies init enhancement when AI result is valid", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-enhance-ok-"));
    const { deps, notices } = createDeps({
      runAutoDevInitEnhancement: async ({ requirementsPath }) => {
        const current = await fs.readFile(requirementsPath, "utf8");
        await fs.writeFile(requirementsPath, `${current}\n## Delivery Notes\n- refined by init enhancement\n`, "utf8");
        return {
          applied: true,
          summary: "Applied source-aware refinement.",
        };
      },
    });
    try {
      await handleAutoDevInitCommand(deps, {
        sessionKey: "session-5",
        message: createMessage("/autodev init"),
        path: tempRoot,
        from: null,
        dryRun: false,
        force: false,
        roomWorkdir: "/home/fallback",
      });

      const requirementsText = await fs.readFile(path.join(tempRoot, "REQUIREMENTS.md"), "utf8");
      expect(requirementsText).toContain("refined by init enhancement");
      expect(notices.at(-1)).toContain("initEnhancement: applied");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back to stage-A baseline when enhancement output is invalid", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-enhance-fallback-"));
    const { deps, notices } = createDeps({
      runAutoDevInitEnhancement: async ({ taskListPath }) => {
        await fs.writeFile(taskListPath, "# TASK_LIST\n\ninvalid content without task rows\n", "utf8");
        return {
          applied: true,
          summary: "Wrote invalid task list to trigger fallback",
        };
      },
    });
    try {
      await handleAutoDevInitCommand(deps, {
        sessionKey: "session-6",
        message: createMessage("/autodev init"),
        path: tempRoot,
        from: null,
        dryRun: false,
        force: false,
        roomWorkdir: "/home/fallback",
      });

      const taskListText = await fs.readFile(path.join(tempRoot, "TASK_LIST.md"), "utf8");
      expect(taskListText).toContain("| T0.1 |");
      expect(notices.at(-1)).toContain("initEnhancement: fallback to stage-A baseline");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("supports --dry-run without writing files", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-init-dry-run-"));
    const { deps, notices, overrides } = createDeps();
    try {
      await handleAutoDevInitCommand(deps, {
        sessionKey: "session-7",
        message: createMessage("/autodev init --dry-run"),
        path: tempRoot,
        from: null,
        dryRun: true,
        force: false,
        roomWorkdir: "/home/fallback",
      });

      await expect(fs.access(path.join(tempRoot, "REQUIREMENTS.md"))).rejects.toThrow();
      await expect(fs.access(path.join(tempRoot, "TASK_LIST.md"))).rejects.toThrow();
      expect(notices.at(-1)).toContain("mode: dry-run");
      expect(notices.at(-1)).toContain("plannedFiles: REQUIREMENTS.md, TASK_LIST.md, docs/AUTODEV_TASK_COMPASS.md");
      expect(overrides.has("session-7")).toBe(false);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("supports --force and overwrites existing scaffold files", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-init-force-"));
    await fs.mkdir(path.join(tempRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# old requirements\n", "utf8");
    await fs.writeFile(path.join(tempRoot, "TASK_LIST.md"), "# old task list\n", "utf8");
    await fs.writeFile(path.join(tempRoot, "docs", "AUTODEV_TASK_COMPASS.md"), "# old compass\n", "utf8");

    const { deps, notices } = createDeps();
    try {
      await handleAutoDevInitCommand(deps, {
        sessionKey: "session-8",
        message: createMessage("/autodev init --force"),
        path: tempRoot,
        from: null,
        dryRun: false,
        force: true,
        roomWorkdir: "/home/fallback",
      });

      const requirementsText = await fs.readFile(path.join(tempRoot, "REQUIREMENTS.md"), "utf8");
      expect(requirementsText).toContain("# REQUIREMENTS");
      expect(notices.at(-1)).toContain("force: on");
      expect(notices.at(-1)).toContain("overwrittenFiles: REQUIREMENTS.md, TASK_LIST.md, docs/AUTODEV_TASK_COMPASS.md");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
