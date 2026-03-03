import { describe, expect, it } from "vitest";

import { isNonLoopbackHost } from "../src/utils/admin-host";

describe("isNonLoopbackHost", () => {
  it("returns false for loopback hosts", () => {
    expect(isNonLoopbackHost("127.0.0.1")).toBe(false);
    expect(isNonLoopbackHost("localhost")).toBe(false);
    expect(isNonLoopbackHost("::1")).toBe(false);
    expect(isNonLoopbackHost("[::1]")).toBe(false);
  });

  it("returns true for non-loopback hosts", () => {
    expect(isNonLoopbackHost("0.0.0.0")).toBe(true);
    expect(isNonLoopbackHost("192.168.1.20")).toBe(true);
    expect(isNonLoopbackHost("::")).toBe(true);
  });
});
