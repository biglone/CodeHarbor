import { describe, expect, it } from "vitest";

import { extractCommandText, splitText } from "../src/utils/message";

describe("extractCommandText", () => {
  it("extracts command body when prefix matches", () => {
    expect(extractCommandText("!code explain this", "!code")).toBe("explain this");
  });

  it("returns null when prefix does not match", () => {
    expect(extractCommandText("hello", "!code")).toBeNull();
  });

  it("accepts all text when prefix is empty", () => {
    expect(extractCommandText(" hello ", "")).toBe("hello");
  });
});

describe("splitText", () => {
  it("splits text by chunk size", () => {
    expect(splitText("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
  });
});
