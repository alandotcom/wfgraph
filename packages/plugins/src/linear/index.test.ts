import { findActionById } from "@rova/shared/plugins/registry";
import { describe, expect, it } from "vitest";
import "#src/linear/index";

/**
 * What a node downstream of a Linear node can reference.
 *
 * Create Ticket's three paths are what the hand-written list carried, word for
 * word. Find Issues gained the inside of its list: `issues` used to be one
 * entry described as "Array of issues found", which a template could name and
 * then had nothing to do with, and the six fields of an issue are addressable
 * now.
 */
describe("linear output fields", () => {
  it("offers what create-ticket returns", () => {
    const action = findActionById("linear/create-ticket");

    expect(action?.outputFields).toEqual([
      { path: "id", description: "Ticket ID", type: "string" },
      { path: "url", description: "Ticket URL", type: "string" },
      { path: "title", description: "Ticket title", type: "string" },
    ]);
  });

  it("offers the fields inside find-issues' list", () => {
    const action = findActionById("linear/find-issues");

    expect(action?.outputFields).toEqual([
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
