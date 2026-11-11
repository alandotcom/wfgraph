import { assert, describe, it as effectIt } from "@effect/vitest";
import { Duration, Effect, Layer, Option, Stream } from "effect";
import {
  SilentAppLoggerLayer,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  makeWorkflowStreamsLayer,
  streamWorkflowDraftRevisions,
  streamWorkflowSummaries,
} from "#src/backend/services/workflows/workflow-streams";
import type {
  WorkflowRepo,
  WorkflowSummaryRow,
} from "#src/backend/services/workflows/repo";
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

/** The shared pollers over a stubbed repository, reading every millisecond. */
function streamsOver(repo: Partial<WorkflowRepo["Service"]>) {
  return makeWorkflowStreamsLayer({ pollIntervalMs: 1 }).pipe(
    Layer.provide(Layer.mergeAll(SilentAppLoggerLayer, stubWorkflowRepo(repo)))
  );
}

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

        const events = yield* streamWorkflowSummaries().pipe(
          Effect.flatMap((stream) => Stream.runCollect(Stream.take(stream, 3))),
          Effect.provide(
            streamsOver({
              listSummariesNewestFirst: Effect.sync(
                () => snapshots[read++] ?? [beta]
              ),
            })
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

      const events = yield* streamWorkflowSummaries().pipe(
        Effect.flatMap((stream) => Stream.runCollect(Stream.take(stream, 2))),
        Effect.provide(
          streamsOver({
            listSummariesNewestFirst: Effect.sync(
              () => snapshots[read++] ?? [renamedBeta, alpha]
            ),
          })
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

describe("streamWorkflowDraftRevisions", () => {
  effectIt.live("emits only revisions newer than the connected client", () =>
    Effect.gen(function* () {
      const revisions = [1, 1, 2, 2, 3];
      let read = 0;
      const events = yield* streamWorkflowDraftRevisions({
        workflowId: "wf_1",
        afterDraftRevision: 1,
      }).pipe(
        Effect.flatMap((stream) => Stream.runCollect(Stream.take(stream, 2))),
        Effect.provide(
          streamsOver({
            findDraftRevisionById: () =>
              Effect.succeed({
                id: "wf_1",
                draftRevision: revisions[read++] ?? 3,
              }),
          })
        )
      );

      assert.deepStrictEqual(Array.from(events), [
        { workflowId: "wf_1", draftRevision: 2 },
        { workflowId: "wf_1", draftRevision: 3 },
      ]);
    })
  );
});

/**
 * Each subscriber used to run a poller of its own, so the database answered
 * one unpaginated list read per open editor tab every half second.
 */
describe("the shared pollers", () => {
  effectIt.live("serve concurrent subscribers to one key from one poller", () =>
    Effect.gen(function* () {
      const reads = { list: 0, drafts: new Map<string, number>() };
      const layer = streamsOver({
        listSummariesNewestFirst: Effect.sync(() => {
          reads.list += 1;
          return [alpha];
        }),
        findDraftRevisionById: (workflowId) =>
          Effect.sync(() => {
            reads.drafts.set(
              workflowId,
              (reads.drafts.get(workflowId) ?? 0) + 1
            );
            return { id: workflowId, draftRevision: 7 };
          }),
      });

      yield* Effect.gen(function* () {
        // Three list subscribers and two subscribers of each of two drafts,
        // all open at once for twenty poll intervals.
        const subscribers = [
          streamWorkflowSummaries(),
          streamWorkflowSummaries(),
          streamWorkflowSummaries(),
          streamWorkflowDraftRevisions({
            workflowId: "wf_a",
            afterDraftRevision: 0,
          }),
          streamWorkflowDraftRevisions({
            workflowId: "wf_a",
            afterDraftRevision: 0,
          }),
          streamWorkflowDraftRevisions({
            workflowId: "wf_b",
            afterDraftRevision: 0,
          }),
        ].map((open) =>
          open.pipe(
            Effect.flatMap((stream: Stream.Stream<unknown, unknown>) =>
              Stream.runDrain(stream)
            )
          )
        );
        yield* Effect.all(subscribers, { concurrency: "unbounded" }).pipe(
          Effect.timeoutOption(Duration.millis(20))
        );
      }).pipe(Effect.provide(layer));

      // One poller per key reads at most once per interval. Six private
      // pollers would have read the list about sixty times.
      assert.isAtLeast(reads.list, 1);
      assert.isAtMost(reads.list, 25);
      assert.deepStrictEqual([...reads.drafts.keys()].toSorted(), [
        "wf_a",
        "wf_b",
      ]);
      assert.isAtMost(reads.drafts.get("wf_a") ?? 0, 25);
    })
  );

  effectIt.live(
    "hand a late subscriber the reading the others already saw",
    () =>
      Effect.gen(function* () {
        const layer = streamsOver({
          listSummariesNewestFirst: Effect.succeed([alpha]),
        });

        const late = yield* Effect.gen(function* () {
          const first = yield* streamWorkflowSummaries();
          // The first subscriber keeps the poller running while it waits.
          yield* Stream.runDrain(first).pipe(Effect.forkScoped);
          yield* Effect.sleep(Duration.millis(10));
          const second = yield* streamWorkflowSummaries();
          return yield* Stream.runHead(second).pipe(
            Effect.timeoutOption(Duration.millis(5))
          );
        }).pipe(Effect.scoped, Effect.provide(layer));

        // The list never changes after the first reading, so only the replayed
        // reading can arrive within the window.
        assert.isTrue(Option.isSome(late) && Option.isSome(late.value));
      })
  );

  effectIt.live("stop polling once the last subscriber leaves", () =>
    Effect.gen(function* () {
      let reads = 0;
      const layer = streamsOver({
        listSummariesNewestFirst: Effect.sync(() => {
          reads += 1;
          return [alpha];
        }),
      });

      const readsAfterLeaving = yield* Effect.gen(function* () {
        const stream = yield* streamWorkflowSummaries();
        yield* Stream.runDrain(stream).pipe(
          Effect.timeoutOption(Duration.millis(10))
        );
        const atLeave = reads;
        yield* Effect.sleep(Duration.millis(20));
        return { atLeave, later: reads };
      }).pipe(Effect.provide(layer));

      assert.isAtLeast(readsAfterLeaving.atLeave, 1);
      assert.strictEqual(readsAfterLeaving.later, readsAfterLeaving.atLeave);
    })
  );
});
