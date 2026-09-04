import { assert, describe, it as effectIt } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import {
  SilentAppLoggerLayer,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { streamWorkflowSummaries } from "#src/backend/services/workflows/list";
import type { WorkflowSummaryRow } from "#src/backend/services/workflows/repo";
import type { WorkflowSummaryPayload } from "@wfgraph/shared/graph/api-contracts";

const alpha: WorkflowSummaryRow = {
  id: "wf_alpha",
  name: "Alpha",
  description: null,
  isPaused: false,
  mode: "live",
  visibility: "private",
  publishedVersionId: null,
  createdAt: new Date("2026-09-04T09:00:00.000Z"),
  updatedAt: new Date("2026-09-04T09:00:00.000Z"),
};

const beta: WorkflowSummaryRow = {
  ...alpha,
  id: "wf_beta",
  name: "Beta",
  updatedAt: new Date("2026-09-04T10:00:00.000Z"),
};

describe("streamWorkflowSummaries", () => {
  effectIt.live(
    "emits the initial list and each changed list while suppressing duplicates",
    () =>
      Effect.gen(function* () {
        const snapshots = [
          [alpha],
          [alpha],
          [beta, alpha],
          [beta, alpha],
          [beta],
        ];
        let read = 0;

        const events = yield* streamWorkflowSummaries({
          pollIntervalMs: 1,
        }).pipe(
          Effect.flatMap((stream) => Stream.runCollect(Stream.take(stream, 3))),
          Effect.provide(
            Layer.mergeAll(
              SilentAppLoggerLayer,
              stubWorkflowRepo({
                listSummariesNewestFirst: Effect.sync(
                  () => snapshots[read++] ?? [beta]
                ),
              })
            )
          )
        );

        assert.deepStrictEqual(Array.from(events), [
          [
            {
              id: "wf_alpha",
              name: "Alpha",
              isPaused: false,
              mode: "live",
              visibility: "private",
              createdAt: "2026-09-04T09:00:00.000Z",
              updatedAt: "2026-09-04T09:00:00.000Z",
            },
          ],
          [
            {
              id: "wf_beta",
              name: "Beta",
              isPaused: false,
              mode: "live",
              visibility: "private",
              createdAt: "2026-09-04T09:00:00.000Z",
              updatedAt: "2026-09-04T10:00:00.000Z",
            },
            {
              id: "wf_alpha",
              name: "Alpha",
              isPaused: false,
              mode: "live",
              visibility: "private",
              createdAt: "2026-09-04T09:00:00.000Z",
              updatedAt: "2026-09-04T09:00:00.000Z",
            },
          ],
          [
            {
              id: "wf_beta",
              name: "Beta",
              isPaused: false,
              mode: "live",
              visibility: "private",
              createdAt: "2026-09-04T09:00:00.000Z",
              updatedAt: "2026-09-04T10:00:00.000Z",
            },
          ],
        ]);
      })
  );

  effectIt.live("uses workflow ids to stabilize equal timestamps", () =>
    Effect.gen(function* () {
      const tiedBeta = { ...beta, updatedAt: alpha.updatedAt };
      const renamedBeta = { ...tiedBeta, name: "Beta renamed" };
      const snapshots = [
        [tiedBeta, alpha],
        [alpha, tiedBeta],
        [renamedBeta, alpha],
      ];
      let read = 0;

      const events = yield* streamWorkflowSummaries({
        pollIntervalMs: 1,
      }).pipe(
        Effect.flatMap((stream) => Stream.runCollect(Stream.take(stream, 2))),
        Effect.provide(
          Layer.mergeAll(
            SilentAppLoggerLayer,
            stubWorkflowRepo({
              listSummariesNewestFirst: Effect.sync(
                () => snapshots[read++] ?? [renamedBeta, alpha]
              ),
            })
          )
        )
      );

      assert.deepStrictEqual(
        Array.from(events).map((workflows) =>
          workflows.map((workflow: WorkflowSummaryPayload) => ({
            id: workflow.id,
            name: workflow.name,
          }))
        ),
        [
          [
            { id: "wf_alpha", name: "Alpha" },
            { id: "wf_beta", name: "Beta" },
          ],
          [
            { id: "wf_alpha", name: "Alpha" },
            { id: "wf_beta", name: "Beta renamed" },
          ],
        ]
      );
    })
  );
});
