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
    expect(snapshot.loadedSkills.planner.some((entry) => entry.includes("dependency-analyzer(builtin)"))).toBe(true);
    expect(snapshot.loadedSkills.executor.some((entry) => entry.includes("autonomous-dev(builtin)"))).toBe(true);
    expect(snapshot.loadedSkills.executor.some((entry) => entry.includes("refactoring(builtin)"))).toBe(true);
    expect(snapshot.loadedSkills.reviewer.some((entry) => entry.includes("code-reviewer(builtin)"))).toBe(true);
    expect(snapshot.loadedSkills.reviewer.some((entry) => entry.includes("review-repair-contract(builtin)"))).toBe(true);
    expect(snapshot.loadedSkills.reviewer.some((entry) => entry.includes("changelog-generator(builtin)"))).toBe(true);
    expect(snapshot.loadedSkills.reviewer.some((entry) => entry.includes("commit-message(builtin)"))).toBe(true);

    const plannerPrompt = catalog.buildPrompt({
      role: "planner",
      stage: "planner",
      round: 0,
    });
    expect(plannerPrompt.text).toContain('skill id="task-planner" source="builtin"');
    expect(plannerPrompt.text).toContain('skill id="builtin-planner-core" source="builtin"');
  });

  it("allows configuring extended builtin fallback skills", () => {
    const catalog = new WorkflowRoleSkillCatalog({
      enabled: true,
      mode: "summary",
      roots: [],
      roleAssignments: {
        planner: ["api-designer"],
        executor: ["performance-optimizer", "auto-code-pipeline", "migration-helper"],
        reviewer: ["commit-message"],
      },
    });

    const plannerPrompt = catalog.buildPrompt({
      role: "planner",
      stage: "planner",
      round: 0,
    });
    expect(plannerPrompt.text).toContain('skill id="api-designer" source="builtin"');

    const executorPrompt = catalog.buildPrompt({
      role: "executor",
      stage: "executor",
      round: 0,
    });
    expect(executorPrompt.text).toContain('skill id="performance-optimizer" source="builtin"');
    expect(executorPrompt.text).toContain('skill id="auto-code-pipeline" source="builtin"');
    expect(executorPrompt.text).toContain('skill id="migration-helper" source="builtin"');

    const reviewerPrompt = catalog.buildPrompt({
      role: "reviewer",
      stage: "reviewer",
      round: 0,
    });
    expect(reviewerPrompt.text).toContain('skill id="commit-message" source="builtin"');
  });

  it("supports community-inspired builtin role skills via assignment override", () => {
    const catalog = new WorkflowRoleSkillCatalog({
      enabled: true,
      mode: "summary",
      maxChars: 10_000,
      roots: [],
      roleAssignments: {
        planner: ["brainstorming", "planning-with-files"],
        executor: ["tdd-workflow", "webapp-testing", "ralph-loop"],
        reviewer: ["code-simplifier", "multi-agent-code-review"],
      },
    });

    const plannerPrompt = catalog.buildPrompt({
      role: "planner",
      stage: "planner",
      round: 0,
    });
    expect(plannerPrompt.text).toContain('skill id="brainstorming" source="builtin"');
    expect(plannerPrompt.text).toContain('skill id="planning-with-files" source="builtin"');

    const executorPrompt = catalog.buildPrompt({
      role: "executor",
      stage: "executor",
      round: 0,
    });
    expect(executorPrompt.text).toContain('skill id="tdd-workflow" source="builtin"');
    expect(executorPrompt.text).toContain('skill id="webapp-testing" source="builtin"');
    expect(executorPrompt.text).toContain('skill id="ralph-loop" source="builtin"');

    const reviewerPrompt = catalog.buildPrompt({
      role: "reviewer",
      stage: "reviewer",
      round: 0,
    });
    expect(reviewerPrompt.text).toContain('skill id="code-simplifier" source="builtin"');
    expect(reviewerPrompt.text).toContain('skill id="multi-agent-code-review" source="builtin"');
  });

  it("supports extended builtin skills inspired by open-source plugin ecosystems", () => {
    const catalog = new WorkflowRoleSkillCatalog({
      enabled: true,
      mode: "full",
      maxChars: 10_000,
      roots: [],
      roleAssignments: {
        planner: ["superpowers-workflow"],
        executor: ["ui-ux-pro-max", "pptx"],
        reviewer: ["multi-agent-code-review"],
      },
    });

    const plannerPrompt = catalog.buildPrompt({
      role: "planner",
      stage: "planner",
      round: 0,
    });
    expect(plannerPrompt.text).toContain('skill id="superpowers-workflow" source="builtin"');
    expect(plannerPrompt.text).toContain("Required sections: SPEC, PLAN, EVIDENCE, VALIDATION, RISKS, NEXT_STEPS, STATUS.");
    expect(plannerPrompt.text).toContain("STATUS must be COMPLETE or INCOMPLETE.");

    const executorPrompt = catalog.buildPrompt({
      role: "executor",
      stage: "executor",
      round: 0,
    });
    expect(executorPrompt.text).toContain('skill id="ui-ux-pro-max" source="builtin"');
    expect(executorPrompt.text).toContain('skill id="pptx" source="builtin"');

    const reviewerPrompt = catalog.buildPrompt({
      role: "reviewer",
      stage: "reviewer",
      round: 0,
    });
    expect(reviewerPrompt.text).toContain('skill id="multi-agent-code-review" source="builtin"');
  });
});
