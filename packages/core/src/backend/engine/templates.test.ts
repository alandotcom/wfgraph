import { describe, expect, it } from "vitest";
import { resolveTemplateString } from "#src/backend/engine/templates";
import { Traversal } from "#src/backend/engine/traversal";

describe("resolveTemplateString", () => {
  it("keeps outputs from node ids that differ only by punctuation separate", () => {
    const traversal = new Traversal([], []);
    const first = { success: true as const, data: { value: "first" } };
    const second = { success: true as const, data: { value: "second" } };

    traversal.markCompleted("a-b", first, {
      label: "A",
      data: first.data,
    });
    traversal.markCompleted("a_b", second, {
      label: "B",
      data: second.data,
    });

    expect(resolveTemplateString("{{@a-b:A.value}}", traversal.outputs)).toBe(
      "first"
    );
  });

  it("stores a prototype-shaped node id as an ordinary output key", () => {
    const traversal = new Traversal([], []);
    const result = { success: true as const, data: { value: "safe" } };

    traversal.markCompleted("__proto__", result, {
      label: "Prototype",
      data: result.data,
    });

    expect(
      resolveTemplateString("{{@__proto__:Prototype.value}}", traversal.outputs)
    ).toBe("safe");
  });
});
