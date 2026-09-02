import { describe, expect, it } from "vitest";
import { fixtureCatalog } from "@wfgraph/agent/tools/catalog-fixture";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { validateAgentPublication } from "#src/backend/agent/publication-validation";

const manualLifecycle: WorkflowNode = {
  id: "entry",
  type: "lifecycle",
  position: { x: 0, y: 0 },
  data: {
    label: "Lifecycle",
    type: "lifecycle",
    config: {
      lifecycleRules: {
        startEvents: [],
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: true,
      },
    },
  },
};

describe("validateAgentPublication", () => {
  it("accepts a configured manual workflow", () => {
    expect(
      validateAgentPublication({
        document: { nodes: [manualLifecycle], edges: [] },
        catalog: fixtureCatalog,
        integrations: [],
      })
    ).toEqual({ publishBlockers: [], warnings: [] });
  });

  it("reports canonical Event and unreachable-node failures", () => {
    const unknownEventLifecycle: WorkflowNode = {
      ...manualLifecycle,
      data: {
        ...manualLifecycle.data,
        config: {
          lifecycleRules: {
            startEvents: ["unknown.event"],
            cancelEvents: [],
            concurrency: "unlimited",
            allowManualStart: false,
          },
        },
      },
    };
    const orphan: WorkflowNode = {
      id: "orphan",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Orphan condition",
        type: "action",
        config: { actionType: "Condition" },
      },
    };

    const result = validateAgentPublication({
      document: { nodes: [unknownEventLifecycle, orphan], edges: [] },
      catalog: fixtureCatalog,
      integrations: [],
    });

    expect(result.publishBlockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "invalid_event" }),
        expect.objectContaining({ kind: "unreachable_node" }),
      ])
    );
  });

  it("keeps deleted-node references as warnings", () => {
    const action: WorkflowNode = {
      id: "notify",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Notify recruiting",
        type: "action",
        config: {
          actionType: "slack/send-message",
          integrationId: "slack-primary",
          channel: "#recruiting",
          text: "Score {{@removed:Removed.score}}",
        },
      },
    };

    const result = validateAgentPublication({
      document: { nodes: [manualLifecycle, action], edges: [] },
      catalog: fixtureCatalog,
      integrations: [{ id: "slack-primary", type: "slack" }],
    });

    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: "broken_reference" })
    );
  });
});

/**
 * The agent's blockers and the publish battery are two lists of the same checks,
 * and the agent's prompt reads an empty list as "ready to publish". A check that
 * reaches one list and not the other is therefore silent: the agent says the
 * workflow is ready and the person who clicks Publish is the one who finds out.
 *
 * These cases are the Start Filter's three publish refusals, each stated here as
 * the agent has to see it.
 */
describe("validateAgentPublication and start filters", () => {
  function filterOn(path: string, value: string): string {
    return JSON.stringify({
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group",
          logic: "and",
          conditions: [
            {
              id: "rule",
              field: path,
              fieldType: "string",
              operator: "equals",
              value,
            },
          ],
        },
      ],
    });
  }

  function filteredWorkflow(filter: string): WorkflowNode {
    return {
      ...manualLifecycle,
      data: {
        ...manualLifecycle.data,
        config: {
          lifecycleRules: {
            startEvents: ["applicant.created"],
            cancelEvents: [],
            concurrency: "unlimited",
            allowManualStart: false,
            startFilters: { "applicant.created": filter },
          },
        },
      },
    };
  }

  const blockersFor = (filter: string) =>
    validateAgentPublication({
      document: { nodes: [filteredWorkflow(filter)], edges: [] },
      catalog: fixtureCatalog,
      integrations: [],
    }).publishBlockers;

  it("accepts a finished filter over a declared field", () => {
    expect(blockersFor(filterOn("email", "a@b.test"))).toEqual([]);
  });

  it("blocks a filter the builder has not finished", () => {
    expect(blockersFor(filterOn("email", ""))).toEqual([
      {
        kind: "invalid_start_filter",
        message: expect.stringContaining("unfinished"),
      },
    ]);
  });

  it("blocks a filter reading a field the Start Event does not carry", () => {
    expect(blockersFor(filterOn("nosuchfield", "x"))).toEqual([
      {
        kind: "invalid_start_filter",
        message: expect.stringContaining("nosuchfield"),
      },
    ]);
  });

  it("blocks a filter comparing against a value from a run", () => {
    expect(blockersFor(filterOn("email", "{{@node1:Lookup.email}}"))).toEqual([
      {
        kind: "invalid_start_filter",
        message: expect.stringContaining("before a run exists"),
      },
    ]);
  });
});
