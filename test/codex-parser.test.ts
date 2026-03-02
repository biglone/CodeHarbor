import { describe, expect, it } from "vitest";

import { parseCodexJsonLine } from "../src/executor/codex-executor";

describe("parseCodexJsonLine", () => {
  it("parses valid json lines", () => {
    const event = parseCodexJsonLine('{"type":"thread.started","thread_id":"abc"}');
    expect(event?.type).toBe("thread.started");
    expect(event?.thread_id).toBe("abc");
  });

  it("returns null for invalid lines", () => {
    expect(parseCodexJsonLine("not-json")).toBeNull();
  });
});
