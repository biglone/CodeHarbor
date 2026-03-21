import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { WorkflowRoleSkillCatalog } from "../src/workflow/role-skills";

describe("WorkflowRoleSkillCatalog", () => {
  it("uses progressive disclosure by round", () => {
    const catalog = new WorkflowRoleSkillCatalog({
      enabled: true,
      mode: "progressive",
      roots: [],
      roleAssignments: {
        planner: ["builtin-planner-core"],
      },
    });

    const round0 = catalog.buildPrompt({
      role: "planner",
      stage: "planner",
      round: 0,
    });
    expect(round0.enabled).toBe(true);
    expect(round0.disclosure).toBe("summary");
    expect(round0.text).toContain('disclosure="summary"');
    expect(round0.text).toContain("Scope the objective, map dependencies");

    const round1 = catalog.buildPrompt({
      role: "planner",
      stage: "planner",
      round: 1,
    });
    expect(round1.disclosure).toBe("full");
    expect(round1.text).toContain('disclosure="full"');
    expect(round1.text).toContain("You own the planning stage");
  });

  it("supports per-run disable override", () => {
    const catalog = new WorkflowRoleSkillCatalog({
      enabled: true,
      mode: "full",
      roots: [],
      roleAssignments: {
        reviewer: ["builtin-reviewer-core"],
      },
    });

    const result = catalog.buildPrompt({
      role: "reviewer",
      stage: "reviewer",
      round: 0,
      policy: {
        enabled: false,
      },
    });

    expect(result.enabled).toBe(false);
    expect(result.text).toBeNull();
    expect(result.usedSkills).toEqual([]);
  });

  it("loads local skills and exposes snapshot details", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-role-skills-"));
    const skillDir = path.join(tempRoot, "executor-local");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "# Executor Local Skill",
        "本地执行增强技能。",
        "",
        "- 优先执行最小变更。",
        "- 完成后返回验证证据。",
      ].join("\n"),
      "utf8",
    );

    try {
      const catalog = new WorkflowRoleSkillCatalog({
        enabled: true,
        mode: "full",
        roots: [tempRoot],
        roleAssignments: {
          executor: ["executor-local"],
        },
      });

      const snapshot = catalog.getStatusSnapshot();
      expect(snapshot.loadedSkills.executor.some((entry) => entry.includes("executor-local(local)"))).toBe(true);

      const prompt = catalog.buildPrompt({
        role: "executor",
        stage: "executor",
        round: 0,
      });
      expect(prompt.text).toContain('skill id="executor-local"');
      expect(prompt.text).toContain("本地执行增强技能");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("provides builtin fallback skills for default assignments", () => {
    const catalog = new WorkflowRoleSkillCatalog({
      enabled: true,
      mode: "summary",
      roots: [],
    });

    const snapshot = catalog.getStatusSnapshot();
    expect(snapshot.loadedSkills.planner.some((entry) => entry.includes("task-planner(builtin)"))).toBe(true);
    expect(snapshot.loadedSkills.executor.some((entry) => entry.includes("autonomous-dev(builtin)"))).toBe(true);
    expect(snapshot.loadedSkills.reviewer.some((entry) => entry.includes("code-reviewer(builtin)"))).toBe(true);

    const plannerPrompt = catalog.buildPrompt({
      role: "planner",
      stage: "planner",
      round: 0,
    });
    expect(plannerPrompt.text).toContain('skill id="task-planner" source="builtin"');
    expect(plannerPrompt.text).toContain('skill id="builtin-planner-core" source="builtin"');
  });
});
