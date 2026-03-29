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

    expectHtmlContains('"/settings/global": "#/settings/global/basic"');
    expectHtmlContains('"/settings/global/basic": "#/settings/global/basic"');
    expectHtmlContains('window.location.hash = pathToRoute[window.location.pathname] || "#/settings/global/basic";');
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
});
