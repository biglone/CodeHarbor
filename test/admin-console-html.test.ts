import { describe, expect, it } from "vitest";

import { ADMIN_CONSOLE_HTML } from "../src/admin-console-html";

function expectHtmlContains(fragment: string): void {
  expect(ADMIN_CONSOLE_HTML).toContain(fragment);
}

describe("admin console paged navigation", () => {
  it("renders functional global section tabs and route mappings", () => {
    const sectionRoutes = [
      "#/settings/global/basic",
      "#/settings/global/autodev",
      "#/settings/global/rate",
      "#/settings/global/triggers",
      "#/settings/global/cli",
      "#/settings/global/agent",
      "#/settings/global/snapshot",
    ];

    for (const route of sectionRoutes) {
      expectHtmlContains(`data-route="${route}"`);
      expectHtmlContains(`"${route}": "settings-global"`);
    }

    expectHtmlContains('data-route="#/settings/bots"');
    expectHtmlContains('"#/settings/bots": "settings-bots"');
    expectHtmlContains('"/settings/bots": "#/settings/bots"');

    expectHtmlContains('"/settings/global": "#/settings/global/basic"');
    expectHtmlContains('"/settings/global/basic": "#/settings/global/basic"');
    expectHtmlContains('window.location.hash = pathToRoute[window.location.pathname] || "#/settings/global/basic";');
    expectHtmlContains("handleRoute();");
  });

  it("normalizes hash route and falls back to global basic section", () => {
    expectHtmlContains("function normalizeRouteHash(hashValue)");
    expectHtmlContains('if (raw === "#/settings/global") {');
    expectHtmlContains('return "#/settings/global/basic";');
    expectHtmlContains('if (raw.indexOf("#/settings/global/") === 0) {');
    expectHtmlContains('if (globalSections.indexOf(section) >= 0) {');
    expectHtmlContains('return "#/settings/global/" + section;');
  });

  it("switches global section visibility and keeps snapshot isolated", () => {
    expectHtmlContains('var globalSections = ["basic", "autodev", "rate", "triggers", "cli", "agent", "snapshot"]');
    expectHtmlContains("var globalSectionFieldMap = {");
    expectHtmlContains("snapshot: []");
    expectHtmlContains("[hidden] {");
    expectHtmlContains("display: none !important;");
    expectHtmlContains("setElementVisible(globalGrid, !isSnapshot);");
    expectHtmlContains("setElementVisible(globalMainActions, !isSnapshot);");
    expectHtmlContains("setElementVisible(globalRestartHint, !isSnapshot);");
    expectHtmlContains("setElementVisible(globalSnapshotBlock, isSnapshot);");
  });

  it("renders skill catalog management controls in global agent section", () => {
    expectHtmlContains('id="global-agent-skills-refresh-btn"');
    expectHtmlContains('id="global-agent-skills-catalog"');
    expectHtmlContains('id="global-agent-skills-missing"');
    expectHtmlContains('apiRequest("/api/admin/config/skills", "GET")');
    expectHtmlContains('"global.agentSkillsCatalog"');
    expectHtmlContains('"global.agentSkillsLoadFailed"');
  });

  it("renders bot profile management actions and apply API wiring", () => {
    expectHtmlContains('data-view="settings-bots"');
    expectHtmlContains('id="bots-profiles-json"');
    expectHtmlContains('id="bots-load-btn"');
    expectHtmlContains('id="bots-save-btn"');
    expectHtmlContains('id="bots-apply-btn"');
    expectHtmlContains('id="global-bot-profiles-auto-retire-default"');
    expectHtmlContains('id="bots-retire-default-toggle"');
    expectHtmlContains('id="bots-form-trigger-group-direct"');
    expectHtmlContains('id="bots-form-trigger-mention"');
    expectHtmlContains('id="bots-form-trigger-reply"');
    expectHtmlContains('id="bots-form-trigger-window"');
    expectHtmlContains('id="bots-form-trigger-prefix"');
    expectHtmlContains('id="bots-form-is-primary"');
    expectHtmlContains('"bots.triggerPolicyTitle"');
    expectHtmlContains('"bots.field.isPrimary"');
    expectHtmlContains('"bots.table.primary"');
    expectHtmlContains('apiRequest("/api/admin/bot-profiles", "GET")');
    expectHtmlContains('apiRequest("/api/admin/bot-profiles", "PUT"');
    expectHtmlContains('apiRequest("/api/admin/bot-profiles/apply", "POST"');
    expectHtmlContains('retireDefaultSingleInstance');
    expectHtmlContains('triggerPolicy');
    expectHtmlContains('isPrimary');
  });
});
