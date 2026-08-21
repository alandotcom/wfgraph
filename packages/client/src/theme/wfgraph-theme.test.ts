import { describe, expect, it } from "vitest";
import { wfgraphTheme } from "./wfgraph-theme";

describe("wfgraphTheme", () => {
  it("defines the complete neutral accent family", () => {
    expect(wfgraphTheme.tokens["--color-accent"]).toBe(
      "light-dark(oklch(0.205 0 0), oklch(0.98 0 0))"
    );
    expect(wfgraphTheme.tokens["--color-accent-muted"]).toBe(
      "light-dark(#1717171A, #F8F8F83F)"
    );
    expect(wfgraphTheme.tokens["--color-on-accent"]).toBe(
      "light-dark(oklch(0.985 0 0), oklch(0.09 0 0))"
    );
  });
});
