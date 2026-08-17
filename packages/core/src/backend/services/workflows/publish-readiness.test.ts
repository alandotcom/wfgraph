/**
 * The publish gate's readiness battery.
 *
 * The refusals here moved from `graph-save.test.ts` when the draft save stopped
 * asking about readiness. They are the same graphs; what changed is which gate
 * answers, and a draft holding any of them now saves. `publish-checks.test.ts`
 * beside this covers the pure reachability half of the same module.
 */

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
import { checkPublishReadiness } from "#src/backend/services/workflows/publish-checks";
import { validateWorkflowGraph } from "#src/backend/services/workflows/validation/workflow-graph";
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

/**
 * The nodes and edges the gate takes, decoded the way `prepareGraphSave` hands
 * them over. Going through the real decoder keeps the fixture honest about what
 * publish actually sees.
 */
function decoded(config: Record<string, unknown>) {
  const validation = validateWorkflowGraph(
    createSerializedWorkflowGraph({
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
          data: { label: "Notify", type: "action", config },
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
    })
  );

  if (!validation.valid) {
    throw new Error(`fixture does not parse: ${validation.error}`);
  }
  return { nodes: validation.nodes, edges: validation.edges };
}

describe("checkPublishReadiness", () => {
  layer(
    Layer.mergeAll(
      SilentAppLoggerLayer,
      catalogLayer,
      stubIntegrationRepo({
        typesByIds: () => Effect.succeed({ int_1: "slack" }),
      })
    )
  )((it) => {
    it.effect("refuses a node with no action selected", () =>
      Effect.gen(function* () {
        const failure = yield* checkPublishReadiness(decoded({})).pipe(
          Effect.flip
        );

        assert.instanceOf(failure, InvalidInput);
        assert.isTrue(failure.error.includes("no action selected"));
      })
    );

    it.effect("refuses a missing required field", () =>
      Effect.gen(function* () {
        const failure = yield* checkPublishReadiness(
          decoded({ actionType: "custom/send", integrationId: "int_1" })
        ).pipe(Effect.flip);

        assert.instanceOf(failure, InvalidInput);
        assert.isTrue(failure.error.includes("missing required fields"));
      })
    );

    it.effect("refuses an action that needs a connection and names none", () =>
      Effect.gen(function* () {
        const failure = yield* checkPublishReadiness(
          decoded({ actionType: "custom/send", channel: "#general" })
        ).pipe(Effect.flip);

        assert.instanceOf(failure, InvalidInput);
        assert.isTrue(failure.error.includes("connection"));
      })
    );

    it.effect("refuses a present integration id nothing carries", () =>
      Effect.gen(function* () {
        const failure = yield* checkPublishReadiness(
          decoded({
            actionType: "custom/send",
            channel: "#general",
            integrationId: "gone",
          })
        ).pipe(
          Effect.provide(
            stubIntegrationRepo({ typesByIds: () => Effect.succeed({}) })
          ),
          Effect.flip
        );

        assert.instanceOf(failure, IntegrationValidationFailed);
        assert.deepStrictEqual(failure.invalidIntegrationIds, ["gone"]);
      })
    );

    it.effect("accepts a fully configured action", () =>
      checkPublishReadiness(
        decoded({
          actionType: "custom/send",
          channel: "#general",
          integrationId: "int_1",
        })
      )
    );
  });
});
