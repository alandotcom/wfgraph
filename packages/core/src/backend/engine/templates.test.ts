import { describe, expect, it } from "vitest";
import {
  processTemplates,
  resolveTemplateString,
} from "#src/backend/engine/templates";
import { Traversal } from "#src/backend/engine/traversal";
import type { JsonObject } from "@wfgraph/shared/types/json";

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

/**
 * A config key holding a JSON object of authored values.
 *
 * Substituting into the whole string is what breaks here: an upstream value
 * carrying a quotation mark or a newline leaves the JSON unparseable, and the
 * step that parses it then reads no values at all rather than one wrong one.
 */
describe("processTemplates over a JSON object of authored values", () => {
  function outputsWith(data: JsonObject) {
    const traversal = new Traversal([], []);
    const result = { success: true as const, data };
    traversal.markCompleted("n1", result, { label: "Lead", data });
    return traversal.outputs;
  }

  it("survives a resolved value carrying a quotation mark and a newline", () => {
    const outputs = outputsWith({ note: 'She said "hi"\nthen left' });

    const processed = processTemplates(
      { vars: JSON.stringify({ NOTE: "{{@n1:Lead.note}}" }) },
      outputs,
      new Set(),
      new Set(["vars"])
    );

    expect(JSON.parse(String(processed.vars))).toEqual({
      NOTE: 'She said "hi"\nthen left',
    });
  });

  it("would have broken the same value without the key named", () => {
    const outputs = outputsWith({ note: 'She said "hi"' });

    const processed = processTemplates(
      { vars: JSON.stringify({ NOTE: "{{@n1:Lead.note}}" }) },
      outputs,
      new Set(),
      new Set()
    );

    // The bug this guards against: whole-string substitution leaves text no
    // parser accepts, so the step reads nothing.
    expect(() => JSON.parse(String(processed.vars))).toThrow();
  });

  it("leaves a number as a number and resolves only the strings", () => {
    const outputs = outputsWith({ name: "Ada" });

    const processed = processTemplates(
      { vars: JSON.stringify({ NAME: "{{@n1:Lead.name}}", COUNT: 3 }) },
      outputs,
      new Set(),
      new Set(["vars"])
    );

    expect(JSON.parse(String(processed.vars))).toEqual({
      NAME: "Ada",
      COUNT: 3,
    });
  });

  it("constructs a top-level __proto__ key as data without changing the prototype", () => {
    const outputs = outputsWith({ name: "Ada" });

    const processed = processTemplates(
      Object.fromEntries([["__proto__", "{{@n1:Lead.name}}"]]),
      outputs,
      new Set()
    );

    expect(Object.hasOwn(processed, "__proto__")).toBe(true);
    expect(processed.__proto__).toBe("Ada");
    expect(Object.getPrototypeOf(processed)).toBe(Object.prototype);
  });

  it("falls back to whole-string resolution for text that is not such an object", () => {
    const outputs = outputsWith({ name: "Ada" });

    // The escape hatch: a builder editing the raw field keeps the behaviour the
    // field always had.
    const processed = processTemplates(
      { vars: "just {{@n1:Lead.name}} text" },
      outputs,
      new Set(),
      new Set(["vars"])
    );

    expect(processed.vars).toBe("just Ada text");
  });

  it("leaves a literal key alone even when it names a template object", () => {
    const outputs = outputsWith({ name: "Ada" });
    const authored = JSON.stringify({ NAME: "{{@n1:Lead.name}}" });

    const processed = processTemplates(
      { vars: authored },
      outputs,
      new Set(["vars"]),
      new Set(["vars"])
    );

    expect(processed.vars).toBe(authored);
  });
});
