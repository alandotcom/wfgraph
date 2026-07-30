import { describe, expect, it } from "vitest";
import { rewriteCelExpression } from "#src/workflow/inngest-event-data";

describe("probe", () => {
  it("leaves a macro loop variable alone", () => {
    expect(
      rewriteCelExpression("items.exists(i, i.x > 1) ? 100 : 50", ["items"])
    ).toBe("event.data.items.exists(i, i.x > 1) ? 100 : 50");
    expect(
      rewriteCelExpression("items.exists(i, i.x > 1) ? 100 : 50", undefined)
    ).toBe("event.data.items.exists(i, i.x > 1) ? 100 : 50");
    expect(rewriteCelExpression('a.p == "h" ? 1 : 2', ["a"])).toBe(
      'event.data.a.p == "h" ? 1 : 2'
    );
  });
});
