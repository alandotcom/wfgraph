import { Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getEventConditionFields,
  getUpstreamConditionFields,
  getUpstreamNodes,
} from "#src/lib/upstream-node-fields";
import {
  anAction,
  anEntryNode,
  anEvent,
  createEdge,
  createNode,
  createSurface,
  type MutableCatalog,
} from "#src/lib/upstream-node-fields-test-support";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
describe("upstream-node-fields conditions", () => {
  // A catalog of its own per case: nothing here outlives the `it` that
  // wrote it, which is what keeps one file's Events out of another's.
  let surface: MutableCatalog;
  beforeEach(() => {
    surface = createSurface();
  });

  it("discovers transitive upstream nodes and condition fields", () => {
    surface.events = [
      anEvent({
        name: "app/appointment.created",
        schema: Schema.Struct({
          data: Schema.Struct({
            id: Schema.String.annotate({ description: "Appointment ID" }),
          }).annotate({ description: "The appointment" }),
        }),
      }),
    ];
    surface.actions = [
      anAction({
        id: "custom/call-api",
        outputFields: [
          { path: "status", description: "Response status", type: "number" },
          {
            path: "result",
            description: "Response body",
            type: "object",
          },
          {
            path: "result.total",
            description: "Total count",
            type: "number",
          },
        ],
      }),
    ];

    const nodes: WorkflowNode[] = [
      anEntryNode({ startEvents: ["app/appointment.created"] }),
      createNode({
        id: "call-1",
        type: "action",
        label: "Call API",
        config: { actionType: "custom/call-api" },
      }),
      createNode({
        id: "wait-1",
        type: "action",
        label: "Wait",
        config: { actionType: "Wait" },
      }),
      createNode({
        id: "condition-1",
        type: "action",
        label: "Condition",
        config: { actionType: "Condition" },
      }),
    ];

    const edges: WorkflowEdge[] = [
      createEdge({
        id: "e1",
        source: "lifecycle-1",
        sourceHandle: LIFECYCLE_STARTED_HANDLE,
        target: "call-1",
      }),
      createEdge({ id: "e2", source: "call-1", target: "wait-1" }),
      createEdge({ id: "e3", source: "wait-1", target: "condition-1" }),
    ];

    const upstreamNodes = getUpstreamNodes({
      currentNodeId: "condition-1",
      nodes,
      edges,
    });
    expect(upstreamNodes.map((node) => node.id)).toEqual([
      "lifecycle-1",
      "call-1",
      "wait-1",
    ]);

    const fields = getUpstreamConditionFields({
      catalog: surface,
      currentNodeId: "condition-1",
      nodes,
      edges,
    });

    expect(fields.some((field) => field.path === "data.id")).toBe(true);
    expect(fields.some((field) => field.path === "result.total")).toBe(true);
    expect(fields.some((field) => field.path === "status")).toBe(true);
  });

  it("includes only condition-compatible primitive fields", () => {
    surface.actions = [
      anAction({
        id: "custom/list-items",
        outputFields: [
          { path: "items", description: "The items found", type: "array" },
          { path: "count", description: "Number of items", type: "number" },
        ],
      }),
    ];

    const nodes: WorkflowNode[] = [
      createNode({
        id: "lifecycle-1",
        type: "lifecycle",
        label: "Webhook",
        config: {},
      }),
      createNode({
        id: "list-1",
        type: "action",
        label: "List",
        config: { actionType: "custom/list-items" },
      }),
      createNode({
        id: "condition-1",
        type: "action",
        label: "Condition",
        config: { actionType: "Condition" },
      }),
    ];

    const edges: WorkflowEdge[] = [
      createEdge({ id: "e1", source: "lifecycle-1", target: "list-1" }),
      createEdge({ id: "e2", source: "list-1", target: "condition-1" }),
    ];

    const fields = getUpstreamConditionFields({
      catalog: surface,
      currentNodeId: "condition-1",
      nodes,
      edges,
    });

    expect(fields.some((field) => field.path === "count")).toBe(true);
    expect(fields.some((field) => field.path === "items")).toBe(false);
  });

  // Output fields declare showWhen the same way config fields do. A delay Wait
  // leaves waitMode unset or "delay", so event-only paths stay out of the picker.

  // A record's keys are invented by whatever produced the payload, so no schema
  // can list them. The graph can: a node that tagged its send named them.
  describe("an open record's keys, read off the graph", () => {
    /** Resend's Send Email, in the shape the catalog carries it. */
    function aSendAction() {
      return anAction({
        id: "resend/send-email",
        integration: "resend",
        configFields: [
          {
            key: "emailTags",
            label: "Tags",
            type: "key-value",
            fillsRecords: ["tags", "data.tags"],
          },
        ],
        outputFields: [
          { path: "id", description: "Email ID", type: "string" },
          {
            path: "tags",
            description: "Email tags",
            type: "object",
            valueType: "string",
          },
        ],
      });
    }

    function aSendNode(tags: Array<{ name: string; value: string }>) {
      return createNode({
        id: "send-1",
        type: "action",
        label: "Send Email",
        config: {
          actionType: "resend/send-email",
          emailTags: JSON.stringify(tags),
        },
      });
    }

    const conditionNode = createNode({
      id: "condition-1",
      type: "action",
      label: "Condition",
      config: { actionType: "Condition" },
    });

    const edges: WorkflowEdge[] = [
      createEdge({ id: "e1", source: "lifecycle-1", target: "send-1" }),
      createEdge({ id: "e2", source: "send-1", target: "condition-1" }),
    ];

    it("offers a tag the upstream node named, beside the record itself", () => {
      surface.actions = [aSendAction()];
      const fields = getUpstreamConditionFields({
        catalog: surface,
        currentNodeId: "condition-1",
        nodes: [
          anEntryNode({}),
          aSendNode([{ name: "name", value: "alan" }]),
          conditionNode,
        ],
        edges,
      });

      const record = fields.find((field) => field.path === "tags");
      expect(record?.openRecord).toBe(true);

      // The whole point: a rule can be built on this without anybody typing it.
      expect(fields.find((field) => field.path === "tags.name")).toMatchObject({
        path: "tags.name",
        label: "tags.name",
        type: "string",
        nullable: true,
      });
      expect(
        fields.find((field) => field.path === "tags.name")?.openRecord
      ).toBeUndefined();
    });

    it("leaves a row nobody has named yet out of the picker", () => {
      surface.actions = [aSendAction()];
      const fields = getUpstreamConditionFields({
        catalog: surface,
        currentNodeId: "condition-1",
        nodes: [
          anEntryNode({}),
          aSendNode([{ name: "  ", value: "half typed" }]),
          conditionNode,
        ],
        edges,
      });

      expect(fields.some((field) => field.path.startsWith("tags."))).toBe(
        false
      );
    });

    // One integration's rows must never name another's record, which is what
    // scoping the collection by integration is for.
    it("keeps one integration's keys off another's record", () => {
      surface.actions = [
        aSendAction(),
        anAction({
          id: "posthog/capture-event",
          integration: "posthog",
          configFields: [
            {
              key: "properties",
              label: "Properties",
              type: "key-value",
              fillsRecords: ["properties"],
            },
          ],
        }),
      ];

      const fields = getUpstreamConditionFields({
        catalog: surface,
        currentNodeId: "condition-1",
        nodes: [
          anEntryNode({}),
          aSendNode([{ name: "name", value: "alan" }]),
          createNode({
            id: "capture-1",
            type: "action",
            label: "Capture",
            config: {
              actionType: "posthog/capture-event",
              properties: JSON.stringify([{ name: "plan", value: "pro" }]),
            },
          }),
          conditionNode,
        ],
        edges: [
          ...edges,
          createEdge({ id: "e3", source: "send-1", target: "capture-1" }),
        ],
      });

      expect(fields.some((field) => field.path === "tags.name")).toBe(true);
      expect(fields.some((field) => field.path === "tags.plan")).toBe(false);
    });

    // The Wait node's case, and the second half of the answer: the tags on a
    // `resend/email.*` payload are the tags the send set, so the same names are
    // what a match on that Event compares.
    it("offers the same tag on the Event a Wait node matches", () => {
      surface.actions = [aSendAction()];
      surface.events = [
        anEvent({
          name: "resend/email.delivered",
          label: "Email delivered",
          integration: "resend",
          schema: Schema.Struct({
            data: Schema.Struct({
              email_id: Schema.String.annotate({ description: "Email ID" }),
              tags: Schema.optionalKey(
                Schema.Record(Schema.String, Schema.String).annotate({
                  description: "Email tags",
                })
              ),
            }),
          }),
        }),
      ];

      const fields = getEventConditionFields(
        surface,
        "resend/email.delivered",
        [anEntryNode({}), aSendNode([{ name: "name", value: "alan" }])]
      );

      expect(
        fields.find((field) => field.path === "data.tags.name")
      ).toMatchObject({ path: "data.tags.name", type: "string" });
    });

    // A row for a key the graph names carries the split a rule stores, so
    // choosing it writes the same rule as choosing the record and typing one.
    it("carries the record and the key on a graph-derived row", () => {
      surface.actions = [aSendAction()];
      const fields = getUpstreamConditionFields({
        catalog: surface,
        currentNodeId: "condition-1",
        nodes: [
          anEntryNode({}),
          aSendNode([{ name: "name", value: "alan" }]),
          conditionNode,
        ],
        edges,
      });

      expect(fields.find((field) => field.path === "tags.name")).toMatchObject({
        recordPath: "tags",
        recordKey: "name",
      });
      expect(
        fields.find((field) => field.path === "tags")?.recordKey
      ).toBeUndefined();
    });

    it("offers the record alone when no node in the graph fills it", () => {
      surface.events = [
        anEvent({
          name: "resend/email.delivered",
          integration: "resend",
          schema: Schema.Struct({
            data: Schema.Struct({
              tags: Schema.optionalKey(
                Schema.Record(Schema.String, Schema.String)
              ),
            }),
          }),
        }),
      ];

      const fields = getEventConditionFields(
        surface,
        "resend/email.delivered",
        []
      );

      expect(fields.find((f) => f.path === "data.tags")?.openRecord).toBe(true);
      expect(fields.some((f) => f.path.startsWith("data.tags."))).toBe(false);
    });
  });
});
