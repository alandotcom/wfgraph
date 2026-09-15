/**
 * The draft-save contract: a graph is stored for its shape, not its readiness.
 *
 * Every case below used to be a refusal. They are here as acceptances because
 * refusing them threw the builder's work away -- the editor suppresses a refused
 * autosave, so the canvas looked dirty and a reload dropped the edit. The
 * matching refusals now live in `publish-checks.test.ts`.
 */

import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { InvalidInput } from "#src/backend/lib/effect/failures";
import { SilentAppLoggerLayer } from "#src/backend/lib/effect/test-layers";
import {
  prepareGraphSave,
  validateGraphSaveShape,
} from "#src/backend/services/workflows/graph-save";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import {
  createDefaultConditionModel,
  serializeConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";

/** A Lifecycle Node and one action wired to its Started outlet. */
function graphWithAction(
  config: Record<string, unknown>,
  lifecycleRules: Record<string, unknown> = {
    startEvents: [],
    cancelEvents: [],
    concurrency: "newest-wins",
    allowManualStart: true,
  }
) {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle-1",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: {
          label: "Start",
          type: "lifecycle",
          config: {
            lifecycleRules,
          },
        },
      },
      {
        id: "action-1",
        type: "action",
        position: { x: 200, y: 0 },
        data: {
          label: "Notify",
          type: "action",
          config,
        },
      },
    ],
    edges: [
      {
        id: "e1",
        source: "lifecycle-1",
        target: "action-1",
        sourceHandle: LIFECYCLE_STARTED_HANDLE,
      },
    ],
  });
}

describe("prepareGraphSave", () => {
  layer(Layer.mergeAll(SilentAppLoggerLayer))((it) => {
    // The four states a canvas passes through while a step is being built. Each
    // one is a save that has to land.
    const halfBuilt: Array<[string, Record<string, unknown>]> = [
      ["no action selected yet", {}],
      [
        "an action whose required field is blank",
        { actionType: "custom/send" },
      ],
      [
        "an action naming no connection",
        { actionType: "custom/send", channel: "#general" },
      ],
      [
        "an action naming a connection nothing carries",
        {
          actionType: "custom/send",
          channel: "#general",
          integrationId: "gone",
        },
      ],
    ];

    for (const [name, config] of halfBuilt) {
      it.effect(`saves a draft holding ${name}`, () =>
        Effect.gen(function* () {
          const prepared = yield* prepareGraphSave({
            graph: graphWithAction(config),
          });

          assert.strictEqual(prepared.nodes.length, 2);
          assert.strictEqual(prepared.edgeCount, 1);
        })
      );
    }

    it.effect("saves a fully configured action", () =>
      Effect.gen(function* () {
        const prepared = yield* prepareGraphSave({
          graph: graphWithAction({
            actionType: "custom/send",
            channel: "#general",
            integrationId: "int_1",
          }),
        });

        assert.strictEqual(prepared.nodes.length, 2);
        assert.strictEqual(prepared.edgeCount, 1);
      })
    );

    // The shape half still refuses. A graph that does not parse is not a draft
    // of anything, and a stored expression the compiler did not produce is one
    // nothing downstream can repair.
    it.effect("refuses a graph that does not parse", () =>
      Effect.gen(function* () {
        const failure = yield* prepareGraphSave({
          graph: { nodes: "not a list", edges: [] },
        }).pipe(Effect.flip);

        assert.instanceOf(failure, InvalidInput);
      })
    );

    it.effect("refuses CEL that disagrees with its own condition model", () =>
      Effect.gen(function* () {
        const model = createDefaultConditionModel(
          {
            path: "appointment.startsAt",
            label: "appointment.startsAt",
            type: "timestamp",
          },
          { groupId: "group-1", conditionId: "condition-1" }
        );

        const failure = yield* prepareGraphSave({
          graph: graphWithAction({
            actionType: "Condition",
            conditionModel: serializeConditionModel(model),
            condition: "appointment.startsAt > now + days(10)",
          }),
        }).pipe(Effect.flip);

        assert.instanceOf(failure, InvalidInput);
      })
    );

    it.effect("refuses a malformed inactive Cancel Filter", () =>
      Effect.gen(function* () {
        const failure = yield* prepareGraphSave({
          graph: graphWithAction(
            {},
            {
              startEvents: [],
              cancelEvents: [],
              concurrency: "newest-wins",
              allowManualStart: true,
              cancelFilters: { "app/appointment.canceled": "{" },
            }
          ),
        }).pipe(Effect.flip);

        assert.instanceOf(failure, InvalidInput);
      })
    );

    it.effect("uses the pure shape refusal text in the service failure", () =>
      Effect.gen(function* () {
        const model = createDefaultConditionModel(
          {
            path: "appointment.startsAt",
            label: "appointment.startsAt",
            type: "timestamp",
          },
          { groupId: "group-1", conditionId: "condition-1" }
        );
        const graph = graphWithAction({
          actionType: "Condition",
          conditionModel: serializeConditionModel(model),
          condition: "appointment.startsAt > now + days(10)",
        });

        const validation = validateGraphSaveShape(graph);
        assert.isFalse(validation.valid);
        if (validation.valid) {
          return;
        }

        const failure = yield* prepareGraphSave({ graph }).pipe(Effect.flip);
        assert.strictEqual(failure.error, validation.error);
      })
    );
  });
});

/**
 * A Lifecycle Node, then a Group holding two lookups, then a send outside it.
 * `frameConfig` is what the frame's `data.config` holds, when it holds one.
 */
function graphWithGroup(
  input: {
    frameConfig?: Record<string, unknown>;
    extraEdges?: Array<{ id: string; source: string; target: string }>;
  } = {}
) {
  const lookup = (id: string) => ({
    id,
    type: "action",
    parentId: "group-1",
    position: { x: 12, y: 48 },
    data: {
      label: id,
      type: "action" as const,
      config: { actionType: "custom/lookup" },
    },
  });
  return {
    attributes: {},
    options: { allowSelfLoops: false, multi: false, type: "directed" },
    nodes: [
      {
        id: "lifecycle-1",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: { label: "Start", type: "lifecycle" as const },
      },
      {
        id: "group-1",
        type: "group",
        position: { x: 0, y: 200 },
        data: {
          label: "Lookups",
          type: "group" as const,
          config: input.frameConfig,
        },
      },
      lookup("lookup-a"),
      lookup("lookup-b"),
      {
        id: "send-1",
        type: "action",
        position: { x: 0, y: 500 },
        data: {
          label: "Send",
          type: "action" as const,
          config: { actionType: "custom/send" },
        },
      },
    ].map((attributes) => ({ key: attributes.id, attributes })),
    edges: [
      {
        id: "in",
        source: "lifecycle-1",
        target: "lookup-a",
        sourceHandle: LIFECYCLE_STARTED_HANDLE,
      },
      { id: "ab", source: "lookup-a", target: "lookup-b" },
      { id: "out", source: "lookup-b", target: "send-1" },
      ...(input.extraEdges ?? []),
    ].map((attributes) => ({
      key: attributes.id,
      source: attributes.source,
      target: attributes.target,
      attributes,
    })),
  };
}

describe("prepareGraphSave with a Group", () => {
  layer(Layer.mergeAll(SilentAppLoggerLayer))((it) => {
    it.effect("saves a Group's membership and executable edges as given", () =>
      Effect.gen(function* () {
        const prepared = yield* prepareGraphSave({ graph: graphWithGroup() });

        assert.deepStrictEqual(
          prepared.nodes.map((node) => [node.id, node.parentId ?? null]),
          [
            ["lifecycle-1", null],
            ["group-1", null],
            ["lookup-a", "group-1"],
            ["lookup-b", "group-1"],
            ["send-1", null],
          ]
        );
        assert.deepStrictEqual(
          prepared.edges.map((edge) => [edge.source, edge.target]),
          [
            ["lifecycle-1", "lookup-a"],
            ["lookup-a", "lookup-b"],
            ["lookup-b", "send-1"],
          ]
        );
      })
    );

    for (const key of ["entryNodeIds", "exitNodeIds", "outletHandle"]) {
      it.effect(`refuses a Group config carrying ${key}`, () =>
        Effect.gen(function* () {
          const failure = yield* prepareGraphSave({
            graph: graphWithGroup({ frameConfig: { [key]: "lookup-a" } }),
          }).pipe(Effect.flip);

          assert.instanceOf(failure, InvalidInput);
          assert.strictEqual(
            failure.error,
            `nodes[1].attributes.data.config.${key}: Group config holds no keys`
          );
        })
      );
    }

    it.effect("refuses a stored edge that names the Group frame", () =>
      Effect.gen(function* () {
        const failure = yield* prepareGraphSave({
          graph: graphWithGroup({
            extraEdges: [
              { id: "frame-out", source: "group-1", target: "send-1" },
            ],
          }),
        }).pipe(Effect.flip);

        assert.instanceOf(failure, InvalidInput);
        assert.strictEqual(
          failure.error,
          'Edge "frame-out" connects to Group "Lookups". Connect a step inside the Group.'
        );
      })
    );
  });
});
