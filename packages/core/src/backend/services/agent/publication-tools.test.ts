import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { fixtureCatalog } from "@wfgraph/agent/tools/catalog-fixture";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { Workflow } from "#src/backend/lib/db/schema";
import {
  SilentAppLoggerLayer,
  stubExtensionCatalog,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { publishStoredDraft } from "#src/backend/services/agent/publication-tools";

// A Slack step with no channel and no connection, which blocks a publish.
const workflow: Workflow = {
  id: "wf_1",
  name: "Workflow",
  description: null,
  graph: createSerializedWorkflowGraph({
    nodes: [
      {
        id: "entry",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: {
          type: "lifecycle",
          label: "Lifecycle",
          config: {
            lifecycleRules: {
              startEvents: ["applicant.created"],
              cancelEvents: [],
              concurrency: "unlimited",
              allowManualStart: false,
            },
          },
        },
      },
      {
        id: "notify",
        type: "action",
        position: { x: 0, y: 200 },
        data: {
          type: "action",
          label: "Notify",
          config: { actionType: "slack/send-message" },
        },
      },
    ],
    edges: [
      {
        id: "e1",
        source: "entry",
        target: "notify",
        sourceHandle: "started",
      },
    ],
  }),
  draftRevision: 3,
  isPaused: false,
  mode: "live",
  visibility: "private",
  publishedVersionId: null,
  createdAt: new Date("2026-09-03T00:00:00.000Z"),
  updatedAt: new Date("2026-09-03T00:00:00.000Z"),
};

// Every other repository method dies, so reaching the publish itself fails.
const services = Layer.mergeAll(
  SilentAppLoggerLayer,
  stubExtensionCatalog(fixtureCatalog),
  stubIntegrationRepo({ listIdentities: Effect.succeed([]) }),
  stubWorkflowRepo({ findById: () => Effect.succeed(workflow) })
);

describe("publishStoredDraft", () => {
  layer(services)((it) => {
    it.effect("answers every blocker and publishes nothing", () =>
      Effect.gen(function* () {
        const answer = yield* publishStoredDraft({
          workflowId: "wf_1",
          expectedDraftRevision: 3,
        });

        assert.strictEqual(answer.status, "blocked");
        assert.strictEqual(answer.draftRevision, 3);
        if (answer.status === "blocked") {
          assert.isTrue(
            answer.publishBlockers.some((blocker) =>
              blocker.startsWith("Notify: ")
            )
          );
        }
      })
    );
  });
});
