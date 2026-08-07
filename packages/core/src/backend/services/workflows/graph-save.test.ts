import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  IntegrationValidationFailed,
  InvalidInput,
} from "#src/backend/lib/effect/failures";
import {
  SilentAppLoggerLayer,
  stubExtensionCatalog,
  stubIntegrationRepo,
} from "#src/backend/lib/effect/test-layers";
import { prepareGraphSave } from "#src/backend/services/workflows/graph-save";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";

const catalogLayer = stubExtensionCatalog({
  actions: [
    {
      id: "custom/send",
      label: "Send Message",
      description: "Sends a message",
      category: "Custom",
      integration: "slack",
      configFields: [
        { key: "channel", label: "Channel", type: "text", required: true },
      ],
      outputFields: [],
    },
  ],
  integrations: [
    {
      type: "slack",
      label: "Slack",
      description: "Slack",
      credentialFields: {},
      hasTest: false,
    },
  ],
});

function graphWithAction(config: Record<string, unknown>) {
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
            lifecycleRules: {
              startEvents: [],
              cancelEvents: [],
              concurrency: "newest-wins",
              allowManualStart: true,
            },
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
  layer(
    Layer.mergeAll(
      SilentAppLoggerLayer,
      catalogLayer,
      stubIntegrationRepo({
        typesByIds: () => Effect.succeed({ int_1: "slack" }),
      })
    )
  )((it) => {
    it.effect("refuses a missing required field", () =>
      Effect.gen(function* () {
        const failure = yield* prepareGraphSave({
          graph: graphWithAction({
            actionType: "custom/send",
            integrationId: "int_1",
          }),
        }).pipe(Effect.flip);

        assert.instanceOf(failure, InvalidInput);
        assert.isTrue(failure.error.includes("missing required fields"));
      })
    );

    it.effect("refuses an action that needs a connection and names none", () =>
      Effect.gen(function* () {
        const failure = yield* prepareGraphSave({
          graph: graphWithAction({
            actionType: "custom/send",
            channel: "#general",
          }),
        }).pipe(Effect.flip);

        assert.instanceOf(failure, InvalidInput);
        assert.isTrue(failure.error.includes("connection"));
      })
    );

    it.effect("refuses a present integration id nothing carries", () =>
      Effect.gen(function* () {
        const failure = yield* prepareGraphSave({
          graph: graphWithAction({
            actionType: "custom/send",
            channel: "#general",
            integrationId: "gone",
          }),
        }).pipe(
          Effect.provide(
            stubIntegrationRepo({
              typesByIds: () => Effect.succeed({}),
            })
          ),
          Effect.flip
        );

        assert.instanceOf(failure, IntegrationValidationFailed);
        assert.deepStrictEqual(failure.invalidIntegrationIds, ["gone"]);
      })
    );

    it.effect("accepts a fully configured action", () =>
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
  });
});
