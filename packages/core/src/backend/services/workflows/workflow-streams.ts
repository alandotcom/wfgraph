/**
 * The two polled streams the editor subscribes to, shared per process.
 *
 * `workflow.subscribeList` and `workflow.subscribeDraft` learn about changes by
 * reading the database on an interval. One poller runs per key (the list, and
 * each workflow id), starts with its first subscriber, fans its readings out to
 * every subscriber, and stops once the last one leaves. A subscriber that joins
 * a running poller receives the latest reading at once.
 */
import { isEqual } from "es-toolkit/predicate";
import {
  Context,
  Duration,
  Effect,
  Layer,
  RcMap,
  Stream,
  type Scope,
} from "effect";
import type { AppLogger } from "#src/backend/lib/effect/app-logger";
import type {
  InternalFailure,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { getWorkflows } from "#src/backend/services/workflows/list";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { getWorkflowDraftRevision } from "#src/backend/services/workflows/workflow";
import type { WorkflowSummaryPayload } from "@wfgraph/shared/graph/api-contracts";

const DEFAULT_POLL_INTERVAL_MS = 500;

type DraftRevision = {
  readonly workflowId: string;
  readonly draftRevision: number;
};

export class WorkflowStreams extends Context.Service<
  WorkflowStreams,
  {
    /** Each distinct complete workflow list, newest first. */
    readonly summaries: Stream.Stream<
      WorkflowSummaryPayload[],
      InternalFailure
    >;
    /** Each distinct persisted draft revision of one workflow. */
    readonly draftRevisions: (
      workflowId: string
    ) => Stream.Stream<DraftRevision, InternalFailure | NotFound>;
  }
>()("@wfgraph/core/WorkflowStreams") {}

/**
 * One reading at a time reaches each subscriber: a slow subscriber skips to the
 * newest reading rather than holding the poller back for everyone else, and
 * `replay` hands a new subscriber the reading the others already saw.
 */
const shareLatest = <A, E, R>(
  stream: Stream.Stream<A, E, R>
): Effect.Effect<Stream.Stream<A, E>, never, Scope.Scope | R> =>
  Stream.share(stream, { capacity: 1, strategy: "sliding", replay: 1 });

/**
 * The shared pollers, held for the life of the runtime that builds this
 * Layer. `pollIntervalMs` is how often a running poller reads the database.
 */
export const makeWorkflowStreamsLayer = (
  options: { readonly pollIntervalMs?: number } = {}
): Layer.Layer<WorkflowStreams, never, WorkflowRepo | AppLogger> =>
  Layer.effect(
    WorkflowStreams,
    Effect.gen(function* () {
      const ticks = Stream.tick(
        Duration.millis(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
      );

      // The list has one key. An RcMap rather than one `Stream.share` keeps the
      // start-on-first and stop-after-last lifecycle identical for both maps.
      const summaryPolls = yield* RcMap.make({
        lookup: (_key: "summaries") =>
          shareLatest(
            ticks.pipe(
              Stream.mapEffect(() => getWorkflows()),
              Stream.changesWith(isEqual)
            )
          ),
      });
      const draftPolls = yield* RcMap.make({
        lookup: (workflowId: string) =>
          shareLatest(
            ticks.pipe(
              Stream.mapEffect(() => getWorkflowDraftRevision(workflowId)),
              Stream.changesWith(
                (previous, current) =>
                  previous.draftRevision === current.draftRevision
              )
            )
          ),
      });

      return {
        summaries: Stream.unwrap(RcMap.get(summaryPolls, "summaries")),
        draftRevisions: (workflowId) =>
          Stream.unwrap(RcMap.get(draftPolls, workflowId)),
      };
    })
  );

/** Emits the complete workflow list now and after each change. */
export const streamWorkflowSummaries = Effect.fn("streamWorkflowSummaries")(
  function* () {
    return (yield* WorkflowStreams).summaries;
  }
);

/** Emits each persisted draft revision newer than the subscriber's, once. */
export const streamWorkflowDraftRevisions = Effect.fn(
  "streamWorkflowDraftRevisions"
)(function* (input: {
  readonly workflowId: string;
  readonly afterDraftRevision: number;
}) {
  return (yield* WorkflowStreams)
    .draftRevisions(input.workflowId)
    .pipe(
      Stream.filter((event) => event.draftRevision > input.afterDraftRevision)
    );
});
