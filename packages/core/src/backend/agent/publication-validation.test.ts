import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureCatalog } from "@wfgraph/agent/tools/catalog-fixture";
import {
  createDefaultConditionModel,
  serializeConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import {
  validateAgentDraft,
  validateAgentPublication,
} from "#src/backend/agent/publication-validation";

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

const integrationEventCatalog: ExtensionCatalog = {
  ...fixtureCatalog,
  events: [
    ...fixtureCatalog.events,
    {
      name: "slack/message.posted",
      label: "Slack message posted",
      integration: "slack",
      payloadFields: [{ path: "channel", type: "string" }],
    },
    {
      name: "linear/issue.created",
      label: "Linear issue created",
      integration: "linear",
      payloadFields: [{ path: "issueId", type: "string" }],
    },
  ],
};

function integrationEventLifecycle(connectionId: string): WorkflowNode {
  return {
    ...manualLifecycle,
    data: {
      ...manualLifecycle.data,
      label: "Slack lifecycle",
      config: {
        lifecycleRules: {
          startEvents: ["slack/message.posted"],
          cancelEvents: [],
          concurrency: "unlimited",
          allowManualStart: false,
          connectionIds: { "slack/message.posted": connectionId },
        },
      },
    },
  };
}

function integrationEventWait(connectionId: string): WorkflowNode {
  return {
    id: "wait-for-slack",
    type: "action",
    position: { x: 200, y: 0 },
    data: {
      label: "Wait for Slack",
      type: "action",
      config: {
        actionType: "Wait",
        waitMode: "event",
        waitFor: [{ event: "slack/message.posted", connectionId }],
        waitTimeout: "7d",
      },
    },
  };
}

function multiIntegrationEventLifecycle(
  connectionIds: Record<string, string>
): WorkflowNode {
  return {
    ...manualLifecycle,
    data: {
      ...manualLifecycle.data,
      label: "Multi-integration lifecycle",
      config: {
        lifecycleRules: {
          startEvents: ["slack/message.posted", "linear/issue.created"],
          cancelEvents: [],
          concurrency: "unlimited",
          allowManualStart: false,
          connectionIds,
        },
      },
    },
  };
}

function multiIntegrationEventWait(connectionIds: {
  slack: string;
  linear: string;
}): WorkflowNode {
  return {
    id: "wait-for-integrations",
    type: "action",
    position: { x: 200, y: 0 },
    data: {
      label: "Wait for integrations",
      type: "action",
      config: {
        actionType: "Wait",
        waitMode: "event",
        waitFor: [
          { event: "slack/message.posted", connectionId: connectionIds.slack },
          { event: "linear/issue.created", connectionId: connectionIds.linear },
        ],
        waitTimeout: "7d",
      },
    },
  };
}

function repeatedIntegrationEventLifecycle(connectionId: string): WorkflowNode {
  return {
    ...manualLifecycle,
    data: {
      ...manualLifecycle.data,
      label: "Repeated Slack lifecycle",
      config: {
        lifecycleRules: {
          startEvents: ["slack/message.posted"],
          cancelEvents: ["slack/message.posted"],
          concurrency: "unlimited",
          allowManualStart: false,
          connectionIds: { "slack/message.posted": connectionId },
        },
      },
    },
  };
}

const waitEdge: WorkflowEdge = {
  id: "entry-wait",
  source: "entry",
  target: "wait-for-slack",
  sourceHandle: LIFECYCLE_STARTED_HANDLE,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it("leaves invalid Condition models to draft shape validation", () => {
    const result = validateAgentPublication({
      document: {
        nodes: [
          manualLifecycle,
          {
            id: "condition",
            type: "action",
            position: { x: 200, y: 0 },
            data: {
              label: "Check appointment",
              type: "action",
              config: {
                actionType: "Condition",
                condition: "true",
                conditionModel: "not JSON",
              },
            },
          },
        ],
        edges: [
          {
            id: "to-condition",
            source: "entry",
            target: "condition",
            sourceHandle: LIFECYCLE_STARTED_HANDLE,
          },
        ],
      },
      catalog: fixtureCatalog,
      integrations: [],
    });

    expect(result.publishBlockers.map((issue) => issue.kind)).not.toContain(
      "invalid_condition"
    );
  });

  it("blocks a missing Lifecycle Event connection", () => {
    const result = validateAgentPublication({
      document: {
        nodes: [integrationEventLifecycle("deleted-slack")],
        edges: [],
      },
      catalog: integrationEventCatalog,
      integrations: [],
    });

    expect(result.publishBlockers).toContainEqual(
      expect.objectContaining({
        kind: "missing_integration",
        nodeId: "entry",
        nodeLabel: "Slack lifecycle",
      })
    );
  });

  it("blocks a Lifecycle Event connection with the wrong integration type", () => {
    const result = validateAgentPublication({
      document: {
        nodes: [integrationEventLifecycle("linear-primary")],
        edges: [],
      },
      catalog: integrationEventCatalog,
      integrations: [{ id: "linear-primary", type: "linear" }],
    });

    expect(result.publishBlockers).toContainEqual(
      expect.objectContaining({
        kind: "missing_integration",
        nodeId: "entry",
        nodeLabel: "Slack lifecycle",
      })
    );
  });

  it("blocks a missing Wait Event connection", () => {
    const result = validateAgentPublication({
      document: {
        nodes: [manualLifecycle, integrationEventWait("deleted-slack")],
        edges: [waitEdge],
      },
      catalog: integrationEventCatalog,
      integrations: [],
    });

    expect(result.publishBlockers).toContainEqual(
      expect.objectContaining({
        kind: "missing_integration",
        nodeId: "wait-for-slack",
        nodeLabel: "Wait for Slack",
      })
    );
  });

  it("blocks a Wait Event connection with the wrong integration type", () => {
    const result = validateAgentPublication({
      document: {
        nodes: [manualLifecycle, integrationEventWait("linear-primary")],
        edges: [waitEdge],
      },
      catalog: integrationEventCatalog,
      integrations: [{ id: "linear-primary", type: "linear" }],
    });

    expect(result.publishBlockers).toContainEqual(
      expect.objectContaining({
        kind: "missing_integration",
        nodeId: "wait-for-slack",
        nodeLabel: "Wait for Slack",
      })
    );
  });

  it("accepts valid Lifecycle and Wait Event connections", () => {
    const result = validateAgentPublication({
      document: {
        nodes: [
          integrationEventLifecycle("slack-primary"),
          integrationEventWait("slack-primary"),
        ],
        edges: [waitEdge],
      },
      catalog: integrationEventCatalog,
      integrations: [{ id: "slack-primary", type: "slack" }],
    });

    expect(result.publishBlockers).toEqual([]);
  });

  it("reports one missing blocker for each Lifecycle integration type", () => {
    const result = validateAgentPublication({
      document: {
        nodes: [
          multiIntegrationEventLifecycle({
            "slack/message.posted": "deleted-slack",
            "linear/issue.created": "deleted-linear",
          }),
        ],
        edges: [],
      },
      catalog: integrationEventCatalog,
      integrations: [],
    });

    const missingIntegrationMessages = result.publishBlockers
      .filter((issue) => issue.kind === "missing_integration")
      .map((issue) => issue.message);
    expect(missingIntegrationMessages).toHaveLength(2);
    expect(missingIntegrationMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("slack"),
        expect.stringContaining("linear"),
      ])
    );
  });

  it("reports one missing blocker for each Wait subscription integration type", () => {
    const wait = multiIntegrationEventWait({
      slack: "deleted-slack",
      linear: "deleted-linear",
    });
    const result = validateAgentPublication({
      document: {
        nodes: [manualLifecycle, wait],
        edges: [
          {
            ...waitEdge,
            target: wait.id,
          },
        ],
      },
      catalog: integrationEventCatalog,
      integrations: [],
    });

    const missingIntegrationMessages = result.publishBlockers
      .filter((issue) => issue.kind === "missing_integration")
      .map((issue) => issue.message);
    expect(missingIntegrationMessages).toHaveLength(2);
    expect(missingIntegrationMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("slack"),
        expect.stringContaining("linear"),
      ])
    );
  });

  it("deduplicates repeated requirements for one node and integration type", () => {
    const result = validateAgentPublication({
      document: {
        nodes: [repeatedIntegrationEventLifecycle("deleted-slack")],
        edges: [],
      },
      catalog: integrationEventCatalog,
      integrations: [],
    });

    expect(
      result.publishBlockers.filter(
        (issue) => issue.kind === "missing_integration"
      )
    ).toHaveLength(1);
  });

  it("reports one missing-integration blocker per node", () => {
    const result = validateAgentPublication({
      document: {
        nodes: [
          manualLifecycle,
          {
            id: "notify",
            type: "action",
            position: { x: 200, y: 0 },
            data: {
              label: "Notify recruiting",
              type: "action",
              config: {
                actionType: "slack/send-message",
                integrationId: "deleted-slack",
                channel: "#recruiting",
                text: "Applicant received",
              },
            },
          },
        ],
        edges: [],
      },
      catalog: fixtureCatalog,
      integrations: [],
    });

    expect(
      result.publishBlockers.filter(
        (issue) => issue.kind === "missing_integration"
      )
    ).toHaveLength(1);
  });

  it("omits integration blockers when strict validation is disabled", () => {
    vi.stubEnv("WORKFLOW_STRICT_INTEGRATION_VALIDATION", "off");

    const result = validateAgentPublication({
      document: {
        nodes: [
          integrationEventLifecycle("deleted-slack"),
          integrationEventWait("deleted-slack"),
          {
            id: "notify",
            type: "action",
            position: { x: 400, y: 0 },
            data: {
              label: "Notify recruiting",
              type: "action",
              config: {
                actionType: "slack/send-message",
                channel: "#recruiting",
                text: "Applicant {{@removed:Removed.email}}",
              },
            },
          },
        ],
        edges: [waitEdge],
      },
      catalog: integrationEventCatalog,
      integrations: [],
    });

    expect(
      result.publishBlockers.filter(
        (issue) => issue.kind === "missing_integration"
      )
    ).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: "broken_reference", nodeId: "notify" })
    );
  });
});

describe("validateAgentDraft", () => {
  it("keeps duplicate node IDs visible to structural validation", () => {
    const result = validateAgentDraft({
      document: {
        nodes: [manualLifecycle, manualLifecycle],
        edges: [],
      },
      catalog: fixtureCatalog,
      integrations: [],
    });

    expect(result.draftValid).toBe(false);
    expect(result.structuralIssues).toEqual([
      "Graph contains duplicate node IDs",
    ]);
  });

  it.each([
    {
      name: "a missing endpoint",
      edges: [{ id: "missing", source: "entry", target: "gone" }],
      issue: "Graph contains edges with missing source/target nodes",
    },
    {
      name: "a self-loop",
      edges: [{ id: "self", source: "entry", target: "entry" }],
      issue: "Graph cannot contain self-loops",
    },
    {
      name: "parallel edges",
      edges: [
        { id: "parallel-1", source: "entry", target: "action" },
        { id: "parallel-2", source: "entry", target: "action" },
      ],
      issue: "Graph cannot contain parallel edges between the same nodes",
    },
  ])("returns structural validation for $name", ({ edges, issue }) => {
    const action: WorkflowNode = {
      id: "action",
      type: "action",
      position: { x: 200, y: 0 },
      data: {
        label: "Wait",
        type: "action",
        config: { actionType: "Wait", waitDuration: "1h" },
      },
    };

    const result = validateAgentDraft({
      document: { nodes: [manualLifecycle, action], edges },
      catalog: fixtureCatalog,
      integrations: [],
    });

    expect(result).toEqual(
      expect.objectContaining({
        draftValid: false,
        structuralIssues: [issue],
      })
    );
  });

  it("marks Condition CEL that disagrees with its model as structurally invalid", () => {
    const model = createDefaultConditionModel(
      {
        path: "appointment.startsAt",
        label: "appointment.startsAt",
        type: "timestamp",
      },
      { groupId: "group-1", conditionId: "condition-1" }
    );
    const condition: WorkflowNode = {
      id: "condition",
      type: "action",
      position: { x: 200, y: 0 },
      data: {
        label: "Check appointment",
        type: "action",
        config: {
          actionType: "Condition",
          conditionModel: serializeConditionModel(model),
          condition: "appointment.startsAt > now + days(10)",
        },
      },
    };

    const result = validateAgentDraft({
      document: {
        nodes: [manualLifecycle, condition],
        edges: [
          {
            id: "to-condition",
            source: "entry",
            target: "condition",
            sourceHandle: LIFECYCLE_STARTED_HANDLE,
          },
        ],
      },
      catalog: fixtureCatalog,
      integrations: [],
    });

    expect(result.draftValid).toBe(false);
    expect(result.structuralIssues).toEqual([
      expect.stringContaining("condition CEL that does not match"),
    ]);
  });

  it("marks an unreadable Start Filter model as structurally invalid", () => {
    const lifecycle: WorkflowNode = {
      ...manualLifecycle,
      data: {
        ...manualLifecycle.data,
        config: {
          lifecycleRules: {
            startEvents: ["applicant.created"],
            cancelEvents: [],
            concurrency: "unlimited",
            allowManualStart: false,
            startFilters: { "applicant.created": "not JSON" },
          },
        },
      },
    };

    const result = validateAgentDraft({
      document: { nodes: [lifecycle], edges: [] },
      catalog: fixtureCatalog,
      integrations: [],
    });

    expect(result.draftValid).toBe(false);
    expect(result.structuralIssues).toEqual([
      expect.stringContaining(
        'start filter for "applicant.created" is invalid'
      ),
    ]);
  });

  it("keeps topology issues, publication blockers, and warnings in one result", () => {
    const action: WorkflowNode = {
      id: "notify",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Notify recruiting",
        type: "action",
        config: {
          actionType: "slack/send-message",
          channel: "#recruiting",
          text: "Applicant {{@removed:Removed.email}}",
        },
      },
    };
    const duplicateEdge = {
      id: "duplicate",
      source: "entry",
      target: "notify",
    };

    const result = validateAgentDraft({
      document: {
        nodes: [manualLifecycle, action],
        edges: [duplicateEdge, duplicateEdge],
      },
      catalog: fixtureCatalog,
      integrations: [],
    });

    expect(result).toEqual({
      draftValid: false,
      structuralIssues: ["Graph contains duplicate edge IDs"],
      publishBlockers: expect.arrayContaining([
        expect.objectContaining({
          kind: "missing_integration",
          nodeId: "notify",
        }),
      ]),
      warnings: expect.arrayContaining([
        expect.objectContaining({
          kind: "broken_reference",
          nodeId: "notify",
        }),
      ]),
    });
  });
});

/**
 * The agent's blockers and the publish battery are two lists of the same checks,
 * and the agent's prompt reads an empty list as "ready to publish". A check that
 * reaches one list and not the other is therefore silent: the agent says the
 * workflow is ready and the person who clicks Publish is the one who finds out.
 *
 * These cases are lifecycle-filter publish refusals stated as the agent sees
 * them.
 */
describe("validateAgentPublication and lifecycle filters", () => {
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

  const cancelBlockersFor = (filter: string) =>
    validateAgentPublication({
      document: {
        nodes: [
          {
            ...manualLifecycle,
            data: {
              ...manualLifecycle.data,
              config: {
                lifecycleRules: {
                  startEvents: ["applicant.created"],
                  cancelEvents: ["applicant.withdrawn"],
                  concurrency: "unlimited",
                  allowManualStart: false,
                  correlationPaths: {
                    "applicant.withdrawn": "applicantId",
                  },
                  cancelFilters: { "applicant.withdrawn": filter },
                },
              },
            },
          },
        ],
        edges: [],
      },
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

  it("blocks an invalid Cancel Filter", () => {
    expect(cancelBlockersFor(filterOn("nosuchfield", "x"))).toEqual([
      {
        kind: "invalid_cancel_filter",
        message: expect.stringContaining("nosuchfield"),
      },
    ]);
  });
});
