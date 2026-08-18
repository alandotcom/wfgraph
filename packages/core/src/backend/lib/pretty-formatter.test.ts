import { describe, expect, test } from "vitest";
import { createPrettyFormatter } from "#src/backend/lib/pretty-formatter";

const formatter = createPrettyFormatter({
  colors: false,
  properties: true,
  depth: 3,
  width: 120,
});

function format(properties: Record<string, unknown>): string {
  return formatter({
    timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
    level: "error",
    category: ["wfgraph", "engine"],
    message: ["Run failed"],
    rawMessage: "Run failed",
    properties,
  });
}

describe("createPrettyFormatter", () => {
  test("keeps multiline strings on one physical line", () => {
    const output = format({ note: "line1\nline2" });
    expect(output).toContain("note: line1\\nline2");
    expect(output.split("\n").length).toBe(2);
  });

  test("keeps Error stacks on one physical line", () => {
    const output = format({ error: new Error("test error") });
    expect(output).toContain("error: Error: test error");
    expect(output).not.toMatch(/error:.*\n    at /);
    expect(output.split("\n").length).toBe(2);
  });

  test("keeps expanded group members on one physical line", () => {
    const output = format({
      error: {
        message: "failed",
        cause: new Error("root cause"),
      },
    });
    const causeLine = output
      .split("\n")
      .find((line) => line.includes("cause:"));
    expect(causeLine).toBeDefined();
    expect(causeLine).toContain("Error: root cause");
    expect(causeLine).toContain("\\n    at ");
    expect(causeLine).not.toMatch(/cause:.*\n    at /);
    expect(output.split("\n").length).toBe(4);
  });
});
