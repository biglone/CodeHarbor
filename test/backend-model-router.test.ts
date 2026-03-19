import { describe, expect, it } from "vitest";

import { BackendModelRouter } from "../src/routing/backend-model-router";

describe("BackendModelRouter", () => {
  it("matches highest-priority enabled rule", () => {
    const router = new BackendModelRouter([
      {
        id: "low-priority",
        enabled: true,
        priority: 10,
        when: {
          taskTypes: ["chat"],
        },
        target: {
          provider: "codex",
          model: "gpt-5-mini",
        },
      },
      {
        id: "high-priority",
        enabled: true,
        priority: 100,
        when: {
          taskTypes: ["chat"],
          textIncludes: ["urgent"],
        },
        target: {
          provider: "claude",
          model: "claude-sonnet-4-5",
        },
      },
    ]);

    const decision = router.resolve(
      {
        roomId: "!room:example.com",
        senderId: "@alice:example.com",
        taskType: "chat",
        directMessage: true,
        text: "please handle urgent ticket",
      },
      {
        provider: "codex",
        model: "gpt-5",
      },
    );

    expect(decision).toMatchObject({
      source: "rule",
      reasonCode: "rule_match",
      ruleId: "high-priority",
      profile: {
        provider: "claude",
        model: "claude-sonnet-4-5",
      },
    });
  });

  it("supports model-only override while keeping fallback provider", () => {
    const router = new BackendModelRouter([
      {
        id: "model-only",
        enabled: true,
        priority: 1,
        when: {
          taskTypes: ["workflow_run"],
        },
        target: {
          model: "gpt-5-mini",
        },
      },
    ]);

    const decision = router.resolve(
      {
        roomId: "!room:example.com",
        senderId: "@alice:example.com",
        taskType: "workflow_run",
        directMessage: false,
        text: "run workflow",
      },
      {
        provider: "codex",
        model: "gpt-5",
      },
    );

    expect(decision.profile).toEqual({
      provider: "codex",
      model: "gpt-5-mini",
    });
  });

  it("falls back to default profile when no rule matches", () => {
    const router = new BackendModelRouter([
      {
        id: "dm-only",
        enabled: true,
        priority: 10,
        when: {
          directMessage: true,
        },
        target: {
          provider: "claude",
        },
      },
    ]);

    const decision = router.resolve(
      {
        roomId: "!room:example.com",
        senderId: "@alice:example.com",
        taskType: "chat",
        directMessage: false,
        text: "normal group message",
      },
      {
        provider: "codex",
        model: "gpt-5",
      },
    );

    expect(decision).toEqual({
      profile: {
        provider: "codex",
        model: "gpt-5",
      },
      source: "default",
      reasonCode: "default_fallback",
      ruleId: null,
    });
  });

  it("rejects invalid regex in rule definition", () => {
    expect(
      () =>
        new BackendModelRouter([
          {
            id: "bad-regex",
            enabled: true,
            priority: 1,
            when: {
              textRegex: "([",
            },
            target: {
              provider: "codex",
            },
          },
        ]),
    ).toThrow(/textRegex/i);
  });

  it("reports total/enabled rule stats", () => {
    const router = new BackendModelRouter([
      {
        id: "enabled-rule",
        enabled: true,
        priority: 1,
        when: {},
        target: {
          provider: "codex",
        },
      },
      {
        id: "disabled-rule",
        enabled: false,
        priority: 0,
        when: {},
        target: {
          provider: "claude",
        },
      },
    ]);

    expect(router.getStats()).toEqual({
      total: 2,
      enabled: 1,
    });
  });
});
