import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import {
  entityStateConditionPath,
  nodeOutputConditionPath,
  serializeConditionModel,
} from "#src/conditions/conditions";
import type { ExtensionCatalog } from "#src/extensions/catalog";
import { groupContractMatrix } from "#src/graph/group-contract-test-support";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import {
  collectWorkflowIssues,
  findUnconfiguredIntegrationNodes,
  groupWorkflowIssuesForOverlay,
  hasBlockingWorkflowIssues,
  hasDraftRunBlockingIssues,
} from "#src/graph/workflow-issues";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "#src/lifecycle/lifecycle-outlets";

const catalog: ExtensionCatalog = {
  entities: [],
  events: [],
  actions: [
    {
      id: "custom/send",
      label: "Send Message",
      description: "Sends a message",
      category: "Custom",
      integration: "slack",
      configFields: [
        { key: "channel", label: "Channel", type: "text", required: true },
        { key: "message", label: "Message", type: "template-input" },
      ],
      outputFields: [],
    },
    {
      id: "Condition",
      label: "Condition",
      description: "Branches",
      category: "Logic",
      configFields: [],
      outputFields: [],
    },
  ],
  integrations: [
    {
      type: "slack",
      label: "Slack",
      description: "Slack workspace",
      credentialFields: {},
      hasTest: false,
      hasWebhook: false,
    },
  ],
};

function actionNode(
  id: string,
  config: Record<string, unknown>,
  label = "Action"
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label,
      type: "action",
      config,
    },
  };
}

describe("collectWorkflowIssues", () => {
  it("reports missing required fields as blocking", () => {
    const issues = collectWorkflowIssues({
      nodes: [actionNode("a1", { actionType: "custom/send" }, "Notify")],
      edges: [],
      catalog,
      integrations: [{ id: "int_1", type: "slack" }],
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "missing_required_field",
          severity: "blocking",
          nodeId: "a1",
          fieldKey: "channel",
        }),
      ])
    );
    expect(hasBlockingWorkflowIssues(issues)).toBe(true);
  });

  it("reports a missing connection as blocking", () => {
    const issues = collectWorkflowIssues({
      nodes: [
        actionNode(
          "a1",
          { actionType: "custom/send", channel: "#general" },
          "Notify"
        ),
      ],
      edges: [],
      catalog,
      integrations: [],
    });

    expect(issues).toContainEqual(
      expect.objectContaining({
        kind: "missing_integration",
        severity: "blocking",
        integrationType: "slack",
        nodeLabel: "Notify",
      })
    );
  });

  it("treats an unknown integration id as missing", () => {
    const issues = collectWorkflowIssues({
      nodes: [
        actionNode(
          "a1",
          {
            actionType: "custom/send",
            channel: "#general",
            integrationId: "gone",
          },
          "Notify"
        ),
      ],
      edges: [],
      catalog,
      integrations: [{ id: "int_1", type: "slack" }],
    });

    expect(
      issues.some(
        (issue) => issue.kind === "missing_integration" && issue.nodeId === "a1"
      )
    ).toBe(true);
  });

  it("reports orphan template refs as warnings", () => {
    const issues = collectWorkflowIssues({
      nodes: [
        actionNode(
          "a1",
          {
            actionType: "custom/send",
            channel: "#general",
            integrationId: "int_1",
            message: "Hi {{@missing:Gone.name}}",
          },
          "Notify"
        ),
      ],
      edges: [],
      catalog,
      integrations: [{ id: "int_1", type: "slack" }],
    });

    expect(issues).toEqual([
      expect.objectContaining({
        kind: "broken_reference",
        severity: "warning",
        referencedNodeId: "missing",
        displayText: "Gone.name",
        fieldKey: "message",
      }),
    ]);
    expect(hasBlockingWorkflowIssues(issues)).toBe(false);
  });

  it("accepts Entity references when tracking has no Eligibility", () => {
    const entityCatalog: ExtensionCatalog = {
      ...catalog,
      entities: [
        {
          type: "patient",
          label: "Patient",
          stateFields: [{ path: "name", type: "string" }],
          stateSchemaDigest: "patient-state",
        },
      ],
    };
    const lifecycle: WorkflowNode = {
      id: "lifecycle",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: {
        type: "lifecycle",
        label: "Lifecycle",
        config: {
          lifecycleRules: {
            startEvents: [],
            cancelEvents: [],
            concurrency: "unlimited",
            trackedEntity: { type: "patient", bindings: {} },
          },
        },
      },
    };
    const issues = collectWorkflowIssues({
      nodes: [
        lifecycle,
        actionNode(
          "a1",
          {
            actionType: "custom/send",
            channel: "#general",
            integrationId: "int_1",
            message: "Hi {{@$entity:patient|Patient.name}}",
          },
          "Notify"
        ),
      ],
      edges: [],
      catalog: entityCatalog,
      integrations: [{ id: "int_1", type: "slack" }],
    });

    const entityIssues = issues.filter(
      (issue) =>
        issue.kind === "broken_reference" &&
        issue.referencedNodeId === "$entity"
    );
    expect(entityIssues).toEqual([]);
    expect(hasBlockingWorkflowIssues(entityIssues)).toBe(false);
    expect(hasDraftRunBlockingIssues(entityIssues)).toBe(false);
  });

  it("reports a stale Entity Condition field as a Publish-only blocker", () => {
    const entityCatalog: ExtensionCatalog = {
      ...catalog,
      entities: [
        {
          type: "patient",
          label: "Patient",
          stateFields: [{ path: "name", type: "string" }],
          stateSchemaDigest: "patient-state",
        },
      ],
    };
    const lifecycle: WorkflowNode = {
      id: "lifecycle",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: {
        type: "lifecycle",
        label: "Lifecycle",
        config: {
          lifecycleRules: {
            startEvents: [],
            cancelEvents: [],
            concurrency: "unlimited",
            trackedEntity: { type: "patient", bindings: {} },
          },
        },
      },
    };
    const model = serializeConditionModel({
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group",
          logic: "and",
          conditions: [
            {
              id: "missing-field",
              field: entityStateConditionPath("patient", "gone") ?? "",
              fieldType: "string",
              operator: "equals",
              value: "active",
            },
            {
              id: "wrong-type",
              field: entityStateConditionPath("patient", "name") ?? "",
              fieldType: "number",
              operator: "greater_than",
              value: 1,
            },
            {
              id: "valid-type",
              field: entityStateConditionPath("patient", "name") ?? "",
              fieldType: "string",
              operator: "equals",
              value: "Ada",
            },
          ],
        },
      ],
    });

    const issues = collectWorkflowIssues({
      nodes: [
        lifecycle,
        actionNode(
          "condition",
          { actionType: "Condition", conditionModel: model },
          "Check patient"
        ),
      ],
      edges: [],
      catalog: entityCatalog,
      integrations: [],
    });
    const entityIssues = issues.filter(
      (issue) =>
        issue.kind === "broken_reference" &&
        issue.referencedNodeId === "$entity"
    );

    expect(entityIssues).toEqual([
      expect.objectContaining({
        nodeId: "condition",
        fieldKey: "conditionModel",
        fieldLabel: "Continue when",
        displayText: "patient.gone",
        severity: "blocking",
      }),
      expect.objectContaining({
        nodeId: "condition",
        displayText: "patient.name",
        severity: "blocking",
      }),
    ]);
    expect(hasBlockingWorkflowIssues(entityIssues)).toBe(true);
    expect(hasDraftRunBlockingIssues(entityIssues)).toBe(false);
  });

  it("ignores Entity references in inactive Wait fields", () => {
    const issues = collectWorkflowIssues({
      nodes: [
        actionNode("wait", {
          actionType: "Wait",
          waitMode: "delay",
          waitDuration: "1h",
          waitTimeout: "{{@$entity:patient|Patient.gone}}",
        }),
      ],
      edges: [],
      catalog,
      integrations: [],
    });

    expect(issues.filter((issue) => issue.kind === "broken_reference")).toEqual(
      []
    );
  });

  it("accepts Entity references declared by the eligible tracked Entity", () => {
    const entityCatalog: ExtensionCatalog = {
      ...catalog,
      entities: [
        {
          type: "patient",
          label: "Patient",
          stateFields: [{ path: "name", type: "string" }],
          stateSchemaDigest: "patient-state",
        },
      ],
    };
    const lifecycle: WorkflowNode = {
      id: "lifecycle",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: {
        type: "lifecycle",
        label: "Lifecycle",
        config: {
          lifecycleRules: {
            startEvents: [],
            cancelEvents: [],
            concurrency: "unlimited",
            trackedEntity: { type: "patient", bindings: {} },
            entityEligibility: {
              condition: "condition",
              checkpoints: ["before-node"],
            },
          },
        },
      },
    };
    const issues = collectWorkflowIssues({
      nodes: [
        lifecycle,
        actionNode(
          "a1",
          {
            actionType: "custom/send",
            channel: "#general",
            integrationId: "int_1",
            message: "Hi {{@$entity:patient|Patient.name}}",
            nested: { value: "{{@$entity:patient|Patient.gone}}" },
          },
          "Notify"
        ),
      ],
      edges: [],
      catalog: entityCatalog,
      integrations: [{ id: "int_1", type: "slack" }],
    });

    expect(issues.filter((issue) => issue.kind === "broken_reference")).toEqual(
      []
    );
  });

  it("groups issues for the overlay", () => {
    const issues = collectWorkflowIssues({
      nodes: [
        actionNode("a1", { actionType: "custom/send" }, "First"),
        actionNode(
          "a2",
          {
            actionType: "custom/send",
            channel: "#x",
            message: "{{@gone:Old}}",
          },
          "Second"
        ),
      ],
      edges: [],
      catalog,
      integrations: [],
    });

    const grouped = groupWorkflowIssuesForOverlay(issues);
    expect(grouped.totalIssues).toBe(issues.length);
    expect(grouped.missingRequiredFields[0]?.missingFields).toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldKey: "channel" })])
    );
    expect(grouped.missingIntegrations).toEqual([
      expect.objectContaining({
        integrationType: "slack",
        nodeNames: expect.arrayContaining(["First", "Second"]),
      }),
    ]);
    expect(grouped.brokenReferences[0]?.brokenReferences[0]?.displayText).toBe(
      "Old"
    );
  });

  it("keeps the group of a node whose id names a prototype member", () => {
    // A node id is text a saved graph or the build agent chose, and a
    // plain-object grouping writes `result.__proto__ = []`, which replaces the
    // prototype and leaves the node with no group at all.
    const issues = collectWorkflowIssues({
      nodes: [
        actionNode("__proto__", { actionType: "custom/send" }, "Prototype"),
      ],
      edges: [],
      catalog,
      integrations: [],
    });

    const grouped = groupWorkflowIssuesForOverlay(issues);
    expect(grouped.missingRequiredFields).toEqual([
      expect.objectContaining({ nodeId: "__proto__", nodeLabel: "Prototype" }),
    ]);
  });
});

describe("collectWorkflowIssues references to a node that is not upstream", () => {
  const entry: WorkflowNode = {
    id: "life",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { type: "lifecycle", label: "Lifecycle", config: {} },
  };

  /** A configured Send Message node whose Message field holds `message`. */
  function sender(id: string, label: string, message = "Hello"): WorkflowNode {
    return actionNode(
      id,
      {
        actionType: "custom/send",
        channel: "#general",
        integrationId: "int_1",
        message,
      },
      label
    );
  }

  const wait = actionNode(
    "wait",
    {
      actionType: BUILT_IN_ACTION_IDS.wait,
      waitMode: "delay",
      waitDuration: "1h",
    },
    "Wait"
  );

  function fromEntry(
    target: string,
    outlet: string = LIFECYCLE_STARTED_HANDLE
  ): WorkflowEdge {
    return {
      id: `life-${target}`,
      source: "life",
      target,
      sourceHandle: outlet,
    };
  }

  function edge(source: string, target: string): WorkflowEdge {
    return { id: `${source}-${target}`, source, target };
  }

  function issuesFor(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
    return collectWorkflowIssues({
      nodes,
      edges,
      catalog,
      integrations: [{ id: "int_1", type: "slack" }],
    });
  }

  function notUpstream(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
    return issuesFor(nodes, edges).filter(
      (issue) => issue.kind === "reference_not_upstream"
    );
  }

  // Both branches leave the entry node together, so whether Lookup has run
  // when Notify resolves its Message depends on which branch finishes first.
  it("blocks a reference to a node on a parallel branch", () => {
    const issues = issuesFor(
      [
        entry,
        sender("lookup", "Lookup"),
        sender("notify", "Notify", "Hi {{@lookup:Lookup.name}}"),
      ],
      [fromEntry("lookup"), fromEntry("notify")]
    );

    expect(issues).toEqual([
      {
        kind: "reference_not_upstream",
        severity: "blocking",
        nodeId: "notify",
        nodeLabel: "Notify",
        fieldKey: "message",
        fieldLabel: "Message",
        referencedNodeId: "lookup",
        displayText: "Lookup.name",
        message:
          'Node "Notify" reads "Lookup" in Message, but no path leads from "Lookup" to "Notify". Reference only a node upstream of "Notify", or move "Notify" below "Lookup".',
      },
    ]);
    expect(hasBlockingWorkflowIssues(issues)).toBe(true);
    expect(hasDraftRunBlockingIssues(issues)).toBe(true);
    expect(groupWorkflowIssuesForOverlay(issues).brokenReferences).toEqual([
      {
        nodeId: "notify",
        nodeLabel: "Notify",
        brokenReferences: [
          {
            fieldKey: "message",
            fieldLabel: "Message",
            referencedNodeId: "lookup",
            displayText: "Lookup.name",
          },
        ],
      },
    ]);
  });

  it("blocks a reference to a node below the reader", () => {
    expect(
      notUpstream(
        [
          entry,
          sender("notify", "Notify", "Hi {{@lookup:Lookup.name}}"),
          sender("lookup", "Lookup"),
        ],
        [fromEntry("notify"), edge("notify", "lookup")]
      )
    ).toEqual([
      expect.objectContaining({ nodeId: "notify", referencedNodeId: "lookup" }),
    ]);
  });

  it("accepts a reference to an upstream node across a Wait", () => {
    expect(
      notUpstream(
        [
          entry,
          sender("lookup", "Lookup"),
          wait,
          sender("notify", "Notify", "Hi {{@lookup:Lookup.name}}"),
        ],
        [fromEntry("lookup"), edge("lookup", "wait"), edge("wait", "notify")]
      )
    ).toEqual([]);
  });

  it("accepts a reference to the entry node from anywhere below it", () => {
    expect(
      notUpstream(
        [
          entry,
          sender("lookup", "Lookup"),
          wait,
          sender("notify", "Notify", "Hi {{@life:Lifecycle.name}}"),
        ],
        [fromEntry("lookup"), edge("lookup", "wait"), edge("wait", "notify")]
      )
    ).toEqual([]);
  });

  // No node is upstream of itself, but the broken-reference check owns a node
  // naming itself and accepts it, and this rule leaves that verdict alone.
  it("leaves a node that names itself to the broken-reference check", () => {
    const issues = issuesFor(
      [entry, sender("notify", "Notify", "Hi {{@notify:Notify.name}}")],
      [fromEntry("notify")]
    );

    expect(issues).toEqual([]);
  });

  it("keeps a missing node's warning and adds nothing beside it", () => {
    const issues = issuesFor(
      [entry, sender("notify", "Notify", "Hi {{@gone:Gone.name}}")],
      [fromEntry("notify")]
    );

    expect(issues).toEqual([
      expect.objectContaining({
        kind: "broken_reference",
        severity: "warning",
        referencedNodeId: "gone",
      }),
    ]);
  });

  // The Canceled Branch runs once the Started side has stopped, and reads the
  // outputs the run produced before then.
  it("accepts a Canceled-side node reading a Started-side node", () => {
    expect(
      notUpstream(
        [
          entry,
          sender("lookup", "Lookup"),
          sender("cleanup", "Cleanup", "Undo {{@lookup:Lookup.name}}"),
        ],
        [fromEntry("lookup"), fromEntry("cleanup", LIFECYCLE_CANCELED_HANDLE)]
      )
    ).toEqual([]);
  });

  it("blocks a Canceled-side node reading a parallel Canceled-side node", () => {
    expect(
      notUpstream(
        [
          entry,
          sender("first", "First"),
          sender("cleanup", "Cleanup", "Undo {{@first:First.name}}"),
        ],
        [
          fromEntry("first", LIFECYCLE_CANCELED_HANDLE),
          fromEntry("cleanup", LIFECYCLE_CANCELED_HANDLE),
        ]
      )
    ).toEqual([
      expect.objectContaining({ nodeId: "cleanup", referencedNodeId: "first" }),
    ]);
  });

  it("reads a Wait's timing tokens", () => {
    const timed = actionNode(
      "timed",
      {
        actionType: BUILT_IN_ACTION_IDS.wait,
        waitMode: "delay",
        waitDelayTimingMode: "until",
        waitUntil: "{{@lookup:Lookup.startsAt}}",
      },
      "Timed Wait"
    );

    expect(
      notUpstream(
        [entry, sender("lookup", "Lookup"), timed],
        [fromEntry("lookup"), fromEntry("timed")]
      )
    ).toEqual([
      expect.objectContaining({ nodeId: "timed", referencedNodeId: "lookup" }),
    ]);
  });

  // A disabled node never runs, so its templates never resolve.
  it("skips a disabled node", () => {
    const disabled = sender("notify", "Notify", "Hi {{@lookup:Lookup.name}}");
    disabled.data.enabled = false;

    expect(
      notUpstream(
        [entry, sender("lookup", "Lookup"), disabled],
        [fromEntry("lookup"), fromEntry("notify")]
      )
    ).toEqual([]);
  });
});

describe("collectWorkflowIssues Condition rules and their source nodes", () => {
  // The Start Event and the scoring step both offer `score`, which is the case
  // a rule naming no node cannot tell apart.
  const scoringCatalog: ExtensionCatalog = {
    ...catalog,
    events: [
      {
        name: "app/applicant.created",
        label: "Applicant created",
        correlationPath: "applicant.id",
        payloadFields: [
          { path: "applicant.id", type: "string" },
          { path: "score", type: "number" },
        ],
      },
    ],
    actions: [
      ...catalog.actions,
      {
        id: "custom/score",
        label: "Score Applicant",
        description: "Scores an applicant",
        category: "Custom",
        configFields: [],
        outputFields: [{ path: "score", type: "number" }],
      },
    ],
  };

  const lifecycle: WorkflowNode = {
    id: "life",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      type: "lifecycle",
      label: "Lifecycle",
      config: {
        lifecycleRules: {
          startEvents: ["app/applicant.created"],
          cancelEvents: [],
          concurrency: "unlimited",
        },
      },
    },
  };
  const scorer = actionNode("scorer", { actionType: "custom/score" }, "Score");

  function route(fields: readonly string[]): WorkflowNode {
    return actionNode(
      "route",
      {
        actionType: "Condition",
        conditionModel: serializeConditionModel({
          version: 2,
          groupLogic: "and",
          groups: [
            {
              id: "group",
              logic: "and",
              conditions: fields.map((field, index) => ({
                id: `rule-${index}`,
                field,
                fieldType: "number",
                operator: "greater_or_equal",
                value: 80,
              })),
            },
          ],
        }),
      },
      "Route"
    );
  }

  const chain: WorkflowEdge[] = [
    {
      id: "life-scorer",
      source: "life",
      target: "scorer",
      sourceHandle: LIFECYCLE_STARTED_HANDLE,
    },
    { id: "scorer-route", source: "scorer", target: "route" },
  ];

  function issuesFor(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
    return collectWorkflowIssues({
      nodes,
      edges,
      catalog: scoringCatalog,
      integrations: [],
    }).filter(
      (issue) =>
        issue.kind === "shared_condition_path" ||
        issue.kind === "reference_not_upstream"
    );
  }

  it("warns on a rule naming no node whose path two steps above offer", () => {
    const issues = issuesFor(
      [lifecycle, scorer, route(["score", "score"])],
      chain
    );

    expect(issues).toEqual([
      {
        kind: "shared_condition_path",
        severity: "warning",
        nodeId: "route",
        nodeLabel: "Route",
        fieldKey: "conditionModel",
        fieldLabel: "Continue when",
        path: "score",
        readNodeId: "scorer",
        message:
          'Node "Route" tests score, which "Lifecycle" and "Score" all offer, and reads it from "Score". Pick the field again to name the step it comes from.',
      },
    ]);
    expect(hasBlockingWorkflowIssues(issues)).toBe(false);
    expect(groupWorkflowIssuesForOverlay(issues).sharedConditionPaths).toEqual([
      {
        nodeId: "route",
        nodeLabel: "Route",
        problems: [{ path: "score", message: issues[0]?.message }],
      },
    ]);
  });

  it("accepts a rule naming its source node, or a path one step offers", () => {
    expect(
      issuesFor(
        [
          lifecycle,
          scorer,
          route([
            nodeOutputConditionPath("life", "score") ?? "",
            nodeOutputConditionPath("scorer", "score") ?? "",
            "applicant.id",
          ]),
        ],
        chain
      )
    ).toEqual([]);
  });

  it("blocks a rule naming a step that is not above the Condition", () => {
    const issues = issuesFor(
      [
        lifecycle,
        scorer,
        route([nodeOutputConditionPath("scorer", "score") ?? ""]),
      ],
      [
        {
          id: "life-scorer",
          source: "life",
          target: "scorer",
          sourceHandle: LIFECYCLE_STARTED_HANDLE,
        },
        {
          id: "life-route",
          source: "life",
          target: "route",
          sourceHandle: LIFECYCLE_STARTED_HANDLE,
        },
      ]
    );

    expect(issues).toEqual([
      {
        kind: "reference_not_upstream",
        severity: "blocking",
        nodeId: "route",
        nodeLabel: "Route",
        fieldKey: "conditionModel",
        fieldLabel: "Continue when",
        referencedNodeId: "scorer",
        displayText: "Score.score",
        message:
          'Node "Route" reads "Score" in Continue when, but no path leads from "Score" to "Route". Test only a node upstream of "Route", or move "Route" below "Score".',
      },
    ]);
    expect(hasDraftRunBlockingIssues(issues)).toBe(true);
  });

  it("blocks a rule naming a step the workflow no longer holds", () => {
    const issues = issuesFor(
      [lifecycle, route([nodeOutputConditionPath("deleted", "score") ?? ""])],
      [
        {
          id: "life-route",
          source: "life",
          target: "route",
          sourceHandle: LIFECYCLE_STARTED_HANDLE,
        },
      ]
    );

    expect(issues).toEqual([
      expect.objectContaining({
        kind: "reference_not_upstream",
        severity: "blocking",
        referencedNodeId: "deleted",
        displayText: "score",
        message:
          'Node "Route" tests score from a step that is no longer in the workflow, in Continue when. Pick the field again from a node upstream of "Route".',
      }),
    ]);
  });
});

describe("collectWorkflowIssues Group rules", () => {
  // The editor's badges and publish preflight read this list, so every matrix
  // case must name the same rules publication refuses with.
  it.each(groupContractMatrix)("$name", (matrixCase) => {
    const issues = collectWorkflowIssues({
      nodes: matrixCase.nodes,
      edges: matrixCase.edges,
      catalog,
      integrations: [],
    }).filter((issue) => issue.kind === "invalid_group");

    expect(issues.map((issue) => issue.rule)).toEqual(matrixCase.rules);
    expect(hasBlockingWorkflowIssues(issues)).toBe(matrixCase.rules.length > 0);
    for (const issue of issues) {
      expect(issue).toMatchObject({ nodeId: "g", nodeLabel: "Lookups" });
    }
  });

  it("lists each Group's messages under the Group in the overlay", () => {
    const twoContinuations = groupContractMatrix.find(
      (matrixCase) =>
        matrixCase.name ===
        "two continuation ports to two different outside steps"
    );
    if (!twoContinuations) {
      throw new Error("matrix case missing");
    }

    const grouped = groupWorkflowIssuesForOverlay(
      collectWorkflowIssues({ ...twoContinuations, catalog, integrations: [] })
    );

    expect(grouped.invalidGroups).toEqual([
      {
        nodeId: "g",
        nodeLabel: "Lookups",
        problems: [
          {
            rule: "multiple_continuations",
            message: expect.stringContaining(
              "continues from 2 outlets inside it to 2 steps"
            ),
          },
        ],
      },
    ]);
  });

  // Group membership does not change how a run executes, so a Group problem
  // stops Publish and leaves the draft run free.
  it("blocks Publish and leaves a draft run free", () => {
    const oneMember = groupContractMatrix.find(
      (matrixCase) => matrixCase.name === "one member"
    );
    if (!oneMember) {
      throw new Error("matrix case missing");
    }

    const issues = collectWorkflowIssues({
      ...oneMember,
      catalog,
      integrations: [],
    });

    expect(hasBlockingWorkflowIssues(issues)).toBe(true);
    expect(hasDraftRunBlockingIssues(issues)).toBe(false);
    expect(groupWorkflowIssuesForOverlay(issues)).toMatchObject({
      draftRunBlockingCount: 0,
      publishBlockingCount: 1,
    });
  });
});

describe("collectWorkflowIssues Lifecycle Rules", () => {
  const lifecycleCatalog: ExtensionCatalog = {
    ...catalog,
    events: [
      {
        name: "app/appointment.created",
        label: "Appointment created",
        correlationPath: "appointment.id",
        payloadFields: [{ path: "appointment.id", type: "string" }],
      },
      {
        name: "app/appointment.canceled",
        label: "Appointment canceled",
        correlationPath: "appointment.id",
        payloadFields: [{ path: "appointment.id", type: "string" }],
      },
    ],
  };

  function rule(field: string): string {
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
              field,
              fieldType: "string",
              operator: "equals",
              value: "x",
            },
          ],
        },
      ],
    });
  }

  function lifecycle(rules: Record<string, unknown>): WorkflowNode {
    return {
      id: "lifecycle",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: {
        label: "Lifecycle",
        type: "lifecycle",
        config: { lifecycleRules: rules },
      },
    };
  }

  function collect(rules: Record<string, unknown>) {
    return collectWorkflowIssues({
      nodes: [lifecycle(rules)],
      edges: [],
      catalog: lifecycleCatalog,
      integrations: [],
    });
  }

  // ADR-0016: a filter reading a path its Event does not declare compiles and
  // reads false on every arrival, so Publish refuses it and the editor says so.
  it("reports a Start Filter and a Cancel Filter reading undeclared paths as Publish blockers", () => {
    const issues = collect({
      startEvents: ["app/appointment.created"],
      cancelEvents: ["app/appointment.canceled"],
      concurrency: "unlimited",
      startFilters: { "app/appointment.created": rule("tenantId") },
      cancelFilters: { "app/appointment.canceled": rule("reason") },
    });

    expect(issues).toEqual([
      expect.objectContaining({
        kind: "invalid_lifecycle_rules",
        severity: "blocking",
        nodeId: "lifecycle",
        nodeLabel: "Lifecycle",
        check: "start_filter",
        message: expect.stringContaining("tenantId"),
      }),
      expect.objectContaining({
        kind: "invalid_lifecycle_rules",
        check: "cancel_filter",
        message: expect.stringContaining("reason"),
      }),
    ]);
    expect(hasBlockingWorkflowIssues(issues)).toBe(true);
    expect(hasDraftRunBlockingIssues(issues)).toBe(false);
    expect(groupWorkflowIssuesForOverlay(issues)).toMatchObject({
      draftRunBlockingCount: 0,
      publishBlockingCount: 2,
      invalidLifecycleRules: [
        {
          nodeId: "lifecycle",
          problems: [{ check: "start_filter" }, { check: "cancel_filter" }],
        },
      ],
    });
  });

  it("reports a schedule on a graph with an Event Split as a Publish blocker", () => {
    const issues = collectWorkflowIssues({
      nodes: [
        lifecycle({
          startEvents: ["app/appointment.created"],
          cancelEvents: [],
          concurrency: "unlimited",
          schedules: [{ cron: "0 9 * * *", timeZone: "America/New_York" }],
        }),
        {
          id: "split",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "Split",
            type: "action",
            config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
          },
        },
      ],
      edges: [],
      catalog: lifecycleCatalog,
      integrations: [],
    });

    expect(issues).toEqual([
      expect.objectContaining({
        kind: "invalid_lifecycle_rules",
        severity: "blocking",
        nodeId: "lifecycle",
        check: "schedule",
        message: expect.stringContaining("A scheduled run carries no Event"),
      }),
    ]);
    // A draft run is a manual run, which a schedule never starts.
    expect(hasDraftRunBlockingIssues(issues)).toBe(false);
  });

  it("reports rules preflight refuses as blocking the draft run too", () => {
    const issues = collect({
      startEvents: ["app/appointment.created"],
      cancelEvents: ["app/appointment.created"],
      concurrency: "unlimited",
    });

    expect(issues).toEqual([
      expect.objectContaining({
        kind: "invalid_lifecycle_rules",
        check: "rules",
        message: expect.stringContaining("cannot both start and cancel runs"),
      }),
    ]);
    expect(hasDraftRunBlockingIssues(issues)).toBe(true);
  });

  it("reports Entity Eligibility with no tracked Entity", () => {
    const issues = collect({
      startEvents: ["app/appointment.created"],
      cancelEvents: [],
      concurrency: "unlimited",
      entityEligibility: {
        condition: rule("status"),
        checkpoints: ["before-execution"],
      },
    });

    expect(issues).toEqual([
      expect.objectContaining({ check: "entity_eligibility" }),
    ]);
  });

  it("passes a valid policy and a Lifecycle Node with no stored rules", () => {
    expect(
      collect({
        startEvents: ["app/appointment.created"],
        cancelEvents: [],
        concurrency: "unlimited",
        startFilters: { "app/appointment.created": rule("appointment.id") },
      })
    ).toEqual([]);
    expect(
      collectWorkflowIssues({
        nodes: [
          { ...lifecycle({}), data: { ...lifecycle({}).data, config: {} } },
        ],
        edges: [],
        catalog: lifecycleCatalog,
        integrations: [],
      })
    ).toEqual([]);
  });
});

describe("findUnconfiguredIntegrationNodes", () => {
  it("names enabled actions that need a connection and carry none", () => {
    const results = findUnconfiguredIntegrationNodes({
      nodes: [
        actionNode("a1", { actionType: "custom/send" }, "Notify"),
        actionNode(
          "a2",
          { actionType: "custom/send", integrationId: "int_1" },
          "Bound"
        ),
        actionNode("a3", { actionType: "Condition", condition: "true" }),
      ],
      catalog,
    });

    expect(results).toEqual([
      {
        nodeId: "a1",
        nodeLabel: "Notify",
        integrationType: "slack",
        integrationLabel: "Slack",
      },
    ]);
  });
});
