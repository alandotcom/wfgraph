import { describe, expect, it } from "vitest";
import {
  stepGroups,
  stepMatchesQuery,
  stepSearchText,
} from "#src/lib/step-types";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { ActionMetadata } from "@wfgraph/shared/extensions/catalog";

function action(overrides: Partial<ActionMetadata> = {}): ActionMetadata {
  return {
    id: "Send Email",
    label: "Send Email",
    description: "Send a message",
    category: "Email",
    configFields: [],
    outputFields: [],
    ...overrides,
  };
}

const wait = action({
  id: BUILT_IN_ACTION_IDS.wait,
  label: "Wait",
  description: "Delay execution",
  category: "System",
});

describe("what a node type is found by", () => {
  it("answers to the words people reach for instead of the label", () => {
    const condition = stepSearchText(
      action({
        id: BUILT_IN_ACTION_IDS.condition,
        label: "Condition",
        category: "System",
      })
    );
    const split = stepSearchText(
      action({
        id: BUILT_IN_ACTION_IDS.eventSplit,
        label: "Event Split",
        category: "System",
      })
    );

    expect(stepSearchText(wait)).toContain("delay");
    expect(stepSearchText(wait)).toContain("pause");
    expect(condition).toContain("branch");
    expect(condition).toContain("if");
    expect(split).toContain("race");
  });

  it("searches a plugin action by its label, category, integration and description", () => {
    const text = stepSearchText(
      action({
        id: "slack/send",
        label: "Send Message",
        description: "Post to a channel",
        category: "Slack",
        integration: "slack",
      })
    );

    expect(text).toContain("Send Message");
    expect(text).toContain("Slack");
    expect(text).toContain("slack");
    expect(text).toContain("Post to a channel");
  });

  it("leaves out the integration a host-defined action does not have", () => {
    // The base action names no integration, which is what a host-defined
    // action looks like.
    expect(stepSearchText(action())).toBe("Send Email Email Send a message");
  });
});

/**
 * The predicate the action grid filters with. It is the palette's own search
 * text behind it, which is what makes the two surfaces answer the same query
 * the same way; the grid used to read three fields of its own and find nothing
 * for "delay".
 */
describe("stepMatchesQuery", () => {
  it("matches a synonym the label does not contain", () => {
    expect(stepMatchesQuery(wait, "delay")).toBe(true);
    expect(stepMatchesQuery(wait, "sleep")).toBe(true);
  });

  it("ignores case on both sides", () => {
    expect(stepMatchesQuery(wait, "DELAY")).toBe(true);
  });

  it("matches everything on an empty query, and nothing on a miss", () => {
    expect(stepMatchesQuery(wait, "")).toBe(true);
    expect(stepMatchesQuery(wait, "zzqq")).toBe(false);
  });
});

describe("how the node types are grouped", () => {
  it("puts System first and sorts the rest by name", () => {
    const groups = stepGroups([
      action({ id: "z/one", category: "Zendesk" }),
      action({ id: "a/one", category: "Airtable" }),
      action({ id: BUILT_IN_ACTION_IDS.wait, category: "System" }),
      action({ id: "a/two", category: "Airtable" }),
    ]);

    expect(groups.map((group) => group.category)).toEqual([
      "System",
      "Airtable",
      "Zendesk",
    ]);
    expect(groups[1].actions.map((item) => item.id)).toEqual([
      "a/one",
      "a/two",
    ]);
  });
});
