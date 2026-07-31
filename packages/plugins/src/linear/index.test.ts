import { requireOutputFieldsFromSchema } from "@rova/core/plugin";
import { describe, expect, it } from "vitest";
import { linear } from "#src/linear/index";

function outputFieldsOf(slug: keyof typeof linear.actions) {
  return requireOutputFieldsFromSchema(
    `Action "linear/${slug}"`,
    linear.actions[slug].output
  );
}

/**
 * What a node downstream of a Linear node can reference.
 *
 * Create Ticket's three paths are what the hand-written list carried, word for
 * word. Find Issues' list exposes the six fields of an issue individually,
 * rather than only `issues` described as "Array of issues found", which a
 * template could name and then have nothing useful to do with.
 */
describe("the linear integration", () => {
  it("declares its credentials and its actions as one value", () => {
    expect(linear.type).toBe("linear");
    expect(linear.test).toBeDefined();
    expect(linear.credentials.map((field) => field.envVar)).toEqual([
      "LINEAR_API_KEY",
      "LINEAR_TEAM_ID",
    ]);
    expect(Object.keys(linear.actions)).toEqual([
      "create-ticket",
      "find-issues",
    ]);
  });

  it("offers what create-ticket returns", () => {
    expect(outputFieldsOf("create-ticket")).toEqual([
      { path: "id", description: "Ticket ID", type: "string" },
      { path: "url", description: "Ticket URL", type: "string" },
      { path: "title", description: "Ticket title", type: "string" },
    ]);
  });

  it("offers the fields inside find-issues' list", () => {
    expect(outputFieldsOf("find-issues")).toEqual([
      { path: "issues", description: "Array of issues found", type: "array" },
      { path: "issues[0].id", description: "Issue ID", type: "string" },
      { path: "issues[0].title", description: "Issue title", type: "string" },
      { path: "issues[0].url", description: "Issue URL", type: "string" },
      {
        path: "issues[0].state",
        description: "Workflow state name",
        type: "string",
      },
      {
        path: "issues[0].priority",
        description: "Priority, 0 (none) through 4 (low)",
        type: "number",
      },
      {
        path: "issues[0].assigneeId",
        description: "Assigned user ID",
        type: "string",
        nullable: true,
      },
      { path: "count", description: "Number of issues", type: "number" },
    ]);
  });
});
