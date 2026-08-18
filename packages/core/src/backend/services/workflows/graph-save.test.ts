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
import { prepareGraphSave } from "#src/backend/services/workflows/graph-save";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import {
  createDefaultConditionModel,
  serializeConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";

/** A Lifecycle Node and one action wired to its Started outlet. */
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
  });
});
