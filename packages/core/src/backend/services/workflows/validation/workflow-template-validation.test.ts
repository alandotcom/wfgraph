import { describe, expect, it } from "vitest";
import { errorOf } from "#src/backend/services/workflows/validation/validation-test-support";
import { validateWorkflowTemplates } from "#src/backend/services/workflows/validation/workflow-template-validation";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { serializeConditionModel } from "@wfgraph/shared/conditions/conditions";
import type {
  EventMetadata,
  ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import type { ReferenceField } from "@wfgraph/shared/graph/node-references";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { eventSplitOutlet } from "@wfgraph/shared/lifecycle/event-split";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";

const CREATED = "app/appointment.created";
const RESCHEDULED = "app/appointment.rescheduled";

function anEvent(name: string, payloadFields: ReferenceField[]): EventMetadata {
  return { name, label: name, payloadFields };
}

const catalog: ExtensionCatalog = {
  entities: [],
  events: [
    anEvent(CREATED, [
      { path: "appointmentId", type: "string" },
      { path: "startsAt", type: "timestamp" },
    ]),
    anEvent(RESCHEDULED, [
      { path: "appointmentId", type: "string" },
      { path: "startsAt", type: "string" },
      { path: "leadTime", type: "duration" },
    ]),
  ],
  actions: [],
  integrations: [],
};

function entryNode(
  startEvents: string[],
  entity?: { eligibility: boolean; type?: string }
): WorkflowNode {
  return {
    id: "lifecycle-1",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Lifecycle",
      type: "lifecycle",
      config: {
        lifecycleRules: {
          startEvents,
          cancelEvents: [],
          concurrency: "unlimited",
          ...(entity
            ? {
                trackedEntity: {
                  type: entity.type ?? "patient",
                  bindings: {},
                },
                ...(entity.eligibility
                  ? {
                      entityEligibility: {
                        condition: "condition",
                        checkpoints: ["before-node"],
                      },
                    }
                  : {}),
              }
            : {}),
        },
      },
    },
  };
}

function waitNode(config: Record<string, unknown>): WorkflowNode {
  return {
    id: "wait-1",
    type: "action",
    position: { x: 0, y: 100 },
    data: {
      label: "Wait",
      type: "action",
      config: { actionType: BUILT_IN_ACTION_IDS.wait, ...config },
    },
  };
}

/** The token an editor writes for a path on the entry node. */
function token(path: string): string {
  return `{{@lifecycle-1:Lifecycle.${path}}}`;
}

const startedEdge: WorkflowEdge = {
  id: "e1",
  source: "lifecycle-1",
  sourceHandle: LIFECYCLE_STARTED_HANDLE,
  target: "wait-1",
};

function check(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  extensionCatalog = catalog
) {
  return validateWorkflowTemplates({
    nodes,
    edges,
    catalog: extensionCatalog,
  });
}

const entityCatalog: ExtensionCatalog = {
  ...catalog,
  entities: [
    {
      type: "patient",
      label: "Patient",
      stateFields: [
        { path: "name", type: "string" },
        { path: "delay", type: "duration" },
        { path: "tags", type: "object", valueType: "string" },
      ],
      stateSchemaDigest: "patient-state",
    },
    {
      type: "customer",
      label: "Patient",
      stateFields: [
        { path: "name", type: "string" },
        { path: "delay", type: "duration" },
      ],
      stateSchemaDigest: "customer-state",
    },
  ],
};

function entityToken(path: string): string {
  return `{{@$entity:patient|Patient.${path}}}`;
}

describe("validateWorkflowTemplates Entity State", () => {
  it("accepts a field from the eligible tracked Entity", () => {
    expect(
      check(
        [
          entryNode([CREATED], { eligibility: true }),
          waitNode({ waitDuration: entityToken("delay") }),
        ],
        [startedEdge],
        entityCatalog
      )
    ).toEqual({ valid: true });
  });

  it("validates only Entity references inside consumed JSON values", () => {
    const recordToken = entityToken('tags["order.id"]');
    const providerCatalog: ExtensionCatalog = {
      ...entityCatalog,
      actions: [
        {
          id: "custom/send",
          label: "Send",
          description: "",
          category: "Custom",
          configFields: [
            {
              key: "variables",
              label: "Variables",
              type: "provider-fields",
              optionsSource: { provider: "variables" },
            },
          ],
          outputFields: [],
        },
      ],
    };

    expect(
      check(
        [
          entryNode([CREATED], { eligibility: true }),
          {
            id: "wait-1",
            type: "action",
            position: { x: 0, y: 100 },
            data: {
              label: "Send",
              type: "action",
              config: {
                actionType: "custom/send",
                variables: JSON.stringify({
                  [entityToken("gone")]: "literal key",
                  CUSTOMER: recordToken,
                }),
                nested: { value: entityToken("gone") },
              },
            },
          },
        ],
        [startedEdge],
        providerCatalog
      )
    ).toEqual({ valid: true });
  });

  it("decodes Wait match models before validating Entity paths", () => {
    const recordToken = entityToken('tags["order.id"]');
    const match = serializeConditionModel({
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group",
          logic: "and",
          conditions: [
            {
              id: "rule",
              field: "status",
              fieldType: "string",
              operator: "equals",
              value: recordToken,
            },
          ],
        },
      ],
    });

    expect(
      check(
        [
          entryNode([CREATED], { eligibility: true }),
          waitNode({
            waitMode: "event",
            waitFor: [{ event: CREATED, match }],
            waitTimeout: "1h",
          }),
        ],
        [startedEdge],
        entityCatalog
      )
    ).toEqual({ valid: true });
  });

  it("refuses Entity data when Eligibility is absent", () => {
    const result = check(
      [
        entryNode([CREATED], { eligibility: false }),
        waitNode({ waitDuration: entityToken("delay") }),
      ],
      [startedEdge],
      entityCatalog
    );

    expect(result.valid).toBe(false);
    expect(errorOf(result)).toContain(
      "available only while Entity Eligibility is configured"
    );
  });

  it("refuses a reference after the tracked Entity type changes", () => {
    const result = check(
      [
        entryNode([CREATED], { eligibility: true, type: "customer" }),
        waitNode({ waitDuration: entityToken("delay") }),
      ],
      [startedEdge],
      entityCatalog
    );

    expect(result.valid).toBe(false);
    expect(errorOf(result)).toContain('Entity "customer" does not declare');
  });

  it("refuses a field the tracked Entity no longer declares", () => {
    const result = check(
      [
        entryNode([CREATED], { eligibility: true }),
        waitNode({ waitDuration: entityToken("gone") }),
      ],
      [startedEdge],
      entityCatalog
    );

    expect(result.valid).toBe(false);
    expect(errorOf(result)).toContain('Entity "patient" does not declare');
  });

  it("ignores Entity references in Wait fields the current mode does not read", () => {
    expect(
      check(
        [
          entryNode([CREATED], { eligibility: true }),
          waitNode({
            waitMode: "delay",
            waitDuration: "1h",
            waitTimeout: entityToken("gone"),
          }),
        ],
        [startedEdge],
        entityCatalog
      )
    ).toEqual({ valid: true });
  });

  it("checks the Entity field type against a typed target", () => {
    const result = check(
      [
        entryNode([CREATED], { eligibility: true }),
        waitNode({ waitDuration: entityToken("name") }),
      ],
      [startedEdge],
      entityCatalog
    );

    expect(result.valid).toBe(false);
    expect(errorOf(result)).toContain("takes a duration");
  });
});

describe("validateWorkflowTemplates", () => {
  it("accepts a duration target reading a duration", () => {
    expect(
      check(
        [
          entryNode([RESCHEDULED]),
          waitNode({ waitDuration: token("leadTime") }),
        ],
        [startedEdge]
      )
    ).toEqual({ valid: true });
  });

  it("refuses a duration target reading a name", () => {
    // The failure this replaces is a run: the engine renders the path to text
    // and `parseDurationMs` answers null on it.
    const result = check(
      [
        entryNode([CREATED]),
        waitNode({ waitDuration: token("appointmentId") }),
      ],
      [startedEdge]
    );

    expect(result.valid).toBe(false);
    expect(errorOf(result)).toContain("waitDuration");
  });

  it("refuses a timestamp target reading a duration", () => {
    const result = check(
      [entryNode([RESCHEDULED]), waitNode({ waitUntil: token("leadTime") })],
      [startedEdge]
    );

    expect(result.valid).toBe(false);
  });

  it("refuses a path the reaching Events type differently", () => {
    // `startsAt` is an instant on one Event and plain text on the other, so it
    // has no type until something narrows the Events to one.
    const result = check(
      [
        entryNode([CREATED, RESCHEDULED]),
        waitNode({ waitUntil: token("startsAt") }),
      ],
      [startedEdge]
    );

    expect(result.valid).toBe(false);
    expect(errorOf(result)).toContain("Event Split");
  });

  it("accepts that same path behind an Event Split", () => {
    const split: WorkflowNode = {
      id: "split-1",
      type: "action",
      position: { x: 0, y: 50 },
      data: {
        label: "Split on Event",
        type: "action",
        config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
      },
    };

    expect(
      check(
        [
          entryNode([CREATED, RESCHEDULED]),
          split,
          waitNode({ waitUntil: token("startsAt") }),
        ],
        [
          { ...startedEdge, target: "split-1" },
          {
            id: "e2",
            source: "split-1",
            sourceHandle: eventSplitOutlet(CREATED),
            target: "wait-1",
          },
        ]
      )
    ).toEqual({ valid: true });
  });

  it("refuses a required target reading a path only some Events carry", () => {
    const result = check(
      [
        entryNode([CREATED, RESCHEDULED]),
        waitNode({ waitDuration: token("leadTime") }),
      ],
      [startedEdge]
    );

    expect(result.valid).toBe(false);
    expect(errorOf(result)).toContain(CREATED);
  });

  it("accepts a blank-tolerating target reading the same path", () => {
    // A wait with no offset writes a blank one, so an absent value is what that
    // key already means.
    expect(
      check(
        [
          entryNode([CREATED, RESCHEDULED]),
          waitNode({ waitOffset: token("leadTime") }),
        ],
        [startedEdge]
      )
    ).toEqual({ valid: true });
  });

  it("passes over a token naming a path no Event declares", () => {
    // A stale token is left to the run rather than refused here: the graph may
    // predate an Event losing the field, and the editor has its own report.
    expect(
      check(
        [entryNode([CREATED]), waitNode({ waitDuration: token("gone") })],
        [startedEdge]
      )
    ).toEqual({ valid: true });
  });
});

describe("validateWorkflowTemplates - what a typed target still reads", () => {
  it("accepts a number in a duration target, which the parser reads as milliseconds", () => {
    const numberCatalog: ExtensionCatalog = {
      ...catalog,
      events: [anEvent(CREATED, [{ path: "waitMs", type: "number" }])],
    };

    expect(
      validateWorkflowTemplates({
        nodes: [
          entryNode([CREATED]),
          waitNode({ waitDuration: token("waitMs") }),
        ],
        edges: [startedEdge],
        catalog: numberCatalog,
      })
    ).toEqual({ valid: true });
  });

  it("accepts a number in a timestamp target, which the parser reads as an epoch", () => {
    const numberCatalog: ExtensionCatalog = {
      ...catalog,
      events: [anEvent(CREATED, [{ path: "startsAtEpoch", type: "number" }])],
    };

    expect(
      validateWorkflowTemplates({
        nodes: [
          entryNode([CREATED]),
          waitNode({ waitUntil: token("startsAtEpoch") }),
        ],
        edges: [startedEdge],
        catalog: numberCatalog,
      })
    ).toEqual({ valid: true });
  });

  it("leaves another action's key alone, whatever the Wait node calls its own", () => {
    // `waitUntil` belongs to the Wait node. A plugin action naming a key the same
    // way means whatever its own schema says.
    const sendAction: ExtensionCatalog = {
      ...catalog,
      actions: [
        {
          id: "custom/send",
          label: "Send",
          description: "",
          category: "Custom",
          configFields: [
            { key: "waitUntil", label: "Wait until", type: "template-input" },
          ],
          outputFields: [],
        },
      ],
    };

    expect(
      validateWorkflowTemplates({
        nodes: [
          entryNode([CREATED]),
          {
            id: "wait-1",
            type: "action",
            position: { x: 0, y: 100 },
            data: {
              label: "Send",
              type: "action",
              config: {
                actionType: "custom/send",
                waitUntil: token("appointmentId"),
              },
            },
          },
        ],
        edges: [startedEdge],
        catalog: sendAction,
      })
    ).toEqual({ valid: true });
  });
});

describe("validateWorkflowTemplates - keys the engine never resolves", () => {
  it("leaves a literal key alone, whatever token it holds", () => {
    // A literal key reaches the step as the builder typed it, so no parser ever
    // sees the token and there is nothing for it to fail.
    const literalAction: ExtensionCatalog = {
      ...catalog,
      actions: [
        {
          id: "custom/send",
          label: "Send",
          description: "",
          category: "Custom",
          configFields: [
            {
              key: "testRecipient",
              label: "Test recipient",
              type: "template-input",
              required: true,
              literal: true,
            },
          ],
          outputFields: [],
        },
      ],
    };

    expect(
      validateWorkflowTemplates({
        nodes: [
          entryNode([CREATED, RESCHEDULED]),
          {
            id: "wait-1",
            type: "action",
            position: { x: 0, y: 100 },
            data: {
              label: "Send",
              type: "action",
              config: {
                actionType: "custom/send",
                testRecipient: token("leadTime"),
              },
            },
          },
        ],
        edges: [startedEdge],
        catalog: literalAction,
      })
    ).toEqual({ valid: true });
  });

  it("keeps dotted top-level config keys exact during validation", () => {
    const dottedKeyCatalog: ExtensionCatalog = {
      ...catalog,
      actions: [
        {
          id: "custom/send",
          label: "Send",
          description: "",
          category: "Custom",
          configFields: [
            {
              key: "delivery.message",
              label: "Delivery message",
              type: "template-input",
              required: true,
            },
          ],
          outputFields: [],
        },
      ],
    };
    const result = validateWorkflowTemplates({
      nodes: [
        entryNode([CREATED, RESCHEDULED]),
        {
          id: "wait-1",
          type: "action",
          position: { x: 0, y: 100 },
          data: {
            label: "Send",
            type: "action",
            config: {
              actionType: "custom/send",
              "delivery.message": token("leadTime"),
            },
          },
        },
      ],
      edges: [startedEdge],
      catalog: dottedKeyCatalog,
    });

    expect(result.valid).toBe(false);
    expect(errorOf(result)).toContain("delivery.message");
    expect(errorOf(result)).toContain("does not carry");
  });

  it("validates key-value row values without reading row names", () => {
    const keyValueCatalog: ExtensionCatalog = {
      ...catalog,
      actions: [
        {
          id: "custom/send",
          label: "Send",
          description: "",
          category: "Custom",
          configFields: [
            {
              key: "headers",
              label: "Headers",
              type: "key-value",
              required: true,
            },
          ],
          outputFields: [],
        },
      ],
    };
    const actionWith = (value: string): WorkflowNode => ({
      id: "wait-1",
      type: "action",
      position: { x: 0, y: 100 },
      data: {
        label: "Send",
        type: "action",
        config: {
          actionType: "custom/send",
          headers: JSON.stringify([{ name: token("startsAt"), value }]),
        },
      },
    });

    expect(
      validateWorkflowTemplates({
        nodes: [entryNode([CREATED, RESCHEDULED]), actionWith("fixed")],
        edges: [startedEdge],
        catalog: keyValueCatalog,
      })
    ).toEqual({ valid: true });

    const result = validateWorkflowTemplates({
      nodes: [entryNode([CREATED, RESCHEDULED]), actionWith(token("leadTime"))],
      edges: [startedEdge],
      catalog: keyValueCatalog,
    });
    expect(result.valid).toBe(false);
    expect(errorOf(result)).toContain("leadTime");
  });
});

describe("validateWorkflowTemplates - keys the node's shape does not read", () => {
  // The trap this closes: a builder writes a timeout while parked on an Event,
  // switches the node back to a clock, and the timeout's input leaves the panel.
  // Refusing over it would name a field they cannot see, for a value no run
  // consults.
  it("ignores a leftover timeout on a wait that is back on a clock", () => {
    expect(
      validateWorkflowTemplates({
        nodes: [
          entryNode([CREATED, RESCHEDULED]),
          waitNode({
            waitMode: "delay",
            waitDelayTimingMode: "duration",
            waitDuration: "24h",
            waitTimeout: token("startsAt"),
          }),
        ],
        edges: [startedEdge],
        catalog,
      })
    ).toEqual({ valid: true });
  });

  it("still refuses that timeout while the node parks on an Event", () => {
    const result = validateWorkflowTemplates({
      nodes: [
        entryNode([CREATED, RESCHEDULED]),
        waitNode({ waitMode: "event", waitTimeout: token("leadTime") }),
      ],
      edges: [startedEdge],
      catalog,
    });

    expect(result.valid).toBe(false);
    expect(errorOf(result)).toContain("waitTimeout");
  });

  it("ignores a leftover duration on a wait now parked on an Event", () => {
    expect(
      validateWorkflowTemplates({
        nodes: [
          entryNode([CREATED, RESCHEDULED]),
          waitNode({
            waitMode: "event",
            waitTimeout: "7d",
            waitDuration: token("leadTime"),
          }),
        ],
        edges: [startedEdge],
        catalog,
      })
    ).toEqual({ valid: true });
  });
});
