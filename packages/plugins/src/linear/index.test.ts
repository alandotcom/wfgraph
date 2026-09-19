import { requireOutputFieldsFromSchema } from "@wfgraph/core/plugin";
import { describe, expect, it } from "vitest";
import { linear } from "#src/linear/index";

const integration = linear;

function outputFieldsOf(slug: keyof typeof integration.actions) {
  return requireOutputFieldsFromSchema(
    `Action "linear/${slug}"`,
    integration.actions[slug].output
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
    expect(integration.type).toBe("linear");
    expect(integration.test).toBeDefined();
    expect(Object.keys(integration.credentials)).toEqual([
      "LINEAR_API_KEY",
      "LINEAR_TEAM_ID",
    ]);
    expect(Object.keys(integration.actions)).toEqual([
      "create-ticket",
      "find-issues",
    ]);
  });

  it("offers what create-ticket returns", () => {
    expect(outputFieldsOf("create-ticket")).toEqual([
      { path: "id", label: "Ticket ID", type: "string" },
      { path: "url", label: "Ticket URL", type: "string" },
      { path: "title", label: "Ticket title", type: "string" },
    ]);
  });

  it("offers the fields inside find-issues' list", () => {
    expect(outputFieldsOf("find-issues")).toEqual([
      {
        path: "issues",
        label: "Issues",
        description: "The issues that matched the search.",
        type: "array",
      },
      {
        path: "issues[0].id",
        label: "Issue ID",
        type: "string",
        nullable: true,
      },
      {
        path: "issues[0].title",
        label: "Issue title",
        type: "string",
        nullable: true,
      },
      {
        path: "issues[0].url",
        label: "Issue URL",
        type: "string",
        nullable: true,
      },
      {
        path: "issues[0].state",
        label: "Workflow state name",
        type: "string",
        nullable: true,
      },
      {
        path: "issues[0].priority",
        description: "Priority, 0 (none) through 4 (low)",
        type: "number",
        nullable: true,
      },
      {
        path: "issues[0].assigneeId",
        label: "Assigned user ID",
        type: "string",
        nullable: true,
      },
      { path: "count", label: "Number of issues", type: "number" },
    ]);
  });
});
