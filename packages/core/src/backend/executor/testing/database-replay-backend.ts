/**
 * A `ReplayDatabaseBackend` over a real database, so the replay suites'
 * database-executor cases run each pass through the pass the worker loop
 * opens (`openRunPass`: its fenced and watched writes, its memo, its runtime and
 * its release) and the repository's claim and producer, with the harness's
 * virtual clock as every `now`.
 *
 * The cases keep their in-memory store, which is what their assertions read.
 * What runs on the database is everything the runtime owns: the claim, the
 * memo, each park's wake, and the release. Each park the case's store writes
 * is mirrored onto a wait row of one seeded Execution, because the runtime
 * reads a park's wake from its row. The mirror stands in for the store's park
 * writes and nothing else: it opens the row at the first park, re-parks it
 * when a later attempt of the same Wait parks again, and settles a row once a
 * pass has read its wake.
 */

import { DEFAULT_MAX_STEP_VALUE_BYTES } from "#src/backend/executor/runtime";
import { Effect } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type {
  DurableStepRef,
  WaitForEventOptions,
  WaitWake,
  WorkflowExecutionRuntime,
} from "#src/backend/engine/runtime";
import type { ReplayDatabaseBackend } from "#src/backend/engine/testing/replay-runtime";
import { openRunPass, type RunPass } from "#src/backend/executor/pass";
import type { ConformanceConnection } from "#src/backend/persistence/conformance/support";
import {
  ExecutionRepo,
  type ClaimedRun,
  type ParkWake,
} from "#src/backend/services/executions/repo";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";

const LEASE_MS = 60_000;

/** The virtual clock, in milliseconds from the start of a drive, as a date. */
function virtual(nowMs: number): Date {
  return new Date(nowMs);
}

/** The wake a producer writes onto the row for a harness wake. */
function parkWakeOf(wake: WaitWake): ParkWake {
  return wake.kind === "resume" ? { ...wake, deliveryId: null } : wake;
}

/** The status a settled mirror row takes for the wake a pass read from it. */
function settledStatus(wake: ParkWake): "resumed" | "timed_out" | "cancelled" {
  if (wake.kind === "timeout") return "timed_out";
  if (wake.kind === "cancel" || wake.kind === "exit") return "cancelled";
  return "resumed";
}

const emptyGraph = createSerializedWorkflowGraph({ nodes: [], edges: [] });

/**
 * Answers a function that opens one backend per drive, each on a fresh
 * connection with a workflow and an Execution of its own. `onOpen` is told
 * about every drive that opened one.
 */
export function openDatabaseReplayBackend(
  openConnection: () => Promise<ConformanceConnection>,
  onOpen?: () => void
): () => Promise<ReplayDatabaseBackend> {
  let drives = 0;

  return async () => {
    drives += 1;
    onOpen?.();
    const connection = await openConnection();
    const run = <A, E>(
      effect: Effect.Effect<A, E, ExecutionRepo | WorkflowRepo>
    ): Promise<A> => connection.run(effect);
    const repo = await connection.run(ExecutionRepo);

    const workflowId = `wf_replay_${drives}`;
    const workflowVersionId = `ver_replay_${drives}`;
    const executionId = await run(
      Effect.gen(function* () {
        const workflows = yield* WorkflowRepo;
        const executions = yield* ExecutionRepo;
        yield* workflows.insert({
          id: workflowId,
          name: "Replay",
          graph: emptyGraph,
          eventSubscriptions: [],
        });
        yield* workflows.insertPublishedVersion({
          workflowId,
          versionId: workflowVersionId,
          version: 1,
          expectedPublishedVersionId: null,
          expectedDraftRevision: 1,
          graph: emptyGraph,
          draftGraph: emptyGraph,
          catalogFingerprint: "catalog",
          graphDigest: "digest",
          eventSubscriptions: [],
          now: new Date(),
        });
        const started = yield* executions.startForEntity({
          execution: {
            workflowId,
            workflowVersionId,
            startSource: "manual",
            runMode: "live",
            input: {},
          },
          concurrency: "unlimited",
          startedEntry: { message: "Manual run started", metadata: {} },
          now: virtual(0),
        });
        if (started.status !== "started") {
          throw new Error("The replay Execution was refused");
        }
        return started.execution.id;
      })
    );

    /** Mirror rows by the park's own id: the case store's row, or the step. */
    const rowsByPark = new Map<string, string>();
    /** Mirror rows by the step that parked on them. */
    const rowsByStep = new Map<string, string>();
    /** The pass currently holding the lease. */
    let current: RunPass | null = null;
    /** The harness's virtual clock, as the last pass or release read it. */
    let clockMs = 0;

    function holder() {
      if (!current) throw new Error("No pass holds the replay run's lease");
      return current;
    }

    /**
     * The mirror row a park stands on, opened at its first park and re-parked
     * when a later attempt of the same Wait parks on it again. Its deadline is
     * the one the harness fixed for the park on the virtual clock.
     */
    async function mirrorPark(
      step: DurableStepRef,
      options: WaitForEventOptions,
      deadlineMs: number
    ): Promise<string> {
      const known = rowsByStep.get(step.id);
      if (known !== undefined) return known;

      const parkKey = options.waitStateId;
      const waitUntil = virtual(deadlineMs);
      const existing = rowsByPark.get(parkKey);
      if (existing === undefined) {
        const opened = await run(
          repo.startWait({
            executionId,
            workflowId,
            workflowVersionId,
            nodeId: parkKey,
            nodeName: parkKey,
            side: "started",
            waitType: "delay",
            waitUntil,
          })
        );
        if (!opened) throw new Error(`The mirror park ${parkKey} was refused`);
        rowsByPark.set(parkKey, opened.waitStateId);
        rowsByStep.set(step.id, opened.waitStateId);
        return opened.waitStateId;
      }

      const reparked = await run(
        holder().writes.reparkWait({
          waitStateId: existing,
          workflowVersionId,
          side: "started",
          waitType: "delay",
          waitUntil,
          subscribedEvents: [],
          resumeToken: null,
          metadata: {},
        })
      );
      if (!reparked.ok) {
        throw new Error(
          `The mirror park ${parkKey} could not be parked again: ${reparked.reason}`
        );
      }
      rowsByStep.set(step.id, existing);
      return existing;
    }

    return {
      runtimeForPass: async ({ now, parkDeadline }) => {
        const claimed = await run(
          repo.claimDue({
            lanes: [{ kind: "run", limit: 1 }],
            workerId: "replay",
            leaseMs: LEASE_MS,
            now: virtual(now),
          })
        );
        const own = claimed.find(
          (row): row is ClaimedRun =>
            row.kind === "run" && row.executionId === executionId
        );
        if (!own) {
          throw new Error(
            `The database did not hand the run back at ${now} ms: its release put the run to sleep past the moment the harness woke it`
          );
        }

        clockMs = now;
        // The pass the worker loop's passes open, with the harness running the
        // body and writing the release in `endParkedPass`.
        const pass = openRunPass({
          claimed: own,
          executions: repo,
          workerId: "replay",
          now: () => virtual(clockMs),
          leaseMs: LEASE_MS,
          maxStepValueBytes: DEFAULT_MAX_STEP_VALUE_BYTES,
        });
        const memo = await run(pass.loadMemo);
        current = pass;
        const runtime = pass.port({
          memo,
          runEffect: (effect) => connection.run(effect),
        });

        const passRuntime: WorkflowExecutionRuntime = {
          run: runtime.run,
          runIdempotent: runtime.runIdempotent,
          waitForEvent: async (step, options) => {
            const waitStateId = await mirrorPark(
              step,
              options,
              parkDeadline(step.id)
            );
            return await runtime.waitForEvent(step, {
              ...options,
              waitStateId,
            });
          },
        };
        return passRuntime;
      },

      wakePark: async (stepId, wake, { now }) => {
        // A timeout is the claim's to resolve, at the deadline the mirror row
        // holds, which is the deadline the harness fixed for the park.
        if (wake.kind === "timeout") return;
        const waitStateId = rowsByStep.get(stepId);
        if (waitStateId === undefined) {
          throw new Error(`No mirror park was opened for step ${stepId}`);
        }
        const resolution = await run(
          repo.wakePark({
            executionId,
            waitStateId,
            wake: parkWakeOf(wake),
            now: virtual(now),
          })
        );
        if (!resolution.resolved) {
          throw new Error(`The park of step ${stepId} was no longer waiting`);
        }
      },

      endParkedPass: async ({ now }) => {
        clockMs = now;
        const pass = holder();
        const { writes } = pass;
        const memo = new Set(
          (await run(repo.listStepMemo({ executionId }))).flatMap((entry) =>
            entry.status === "succeeded" ? [entry.stepId] : []
          )
        );
        // A row whose wake the pass read is settled, as the Wait's resume
        // would settle it, so the release reads only wakes no pass has seen.
        for (const waitStateId of new Set(rowsByStep.values())) {
          // eslint-disable-next-line eslint/no-await-in-loop -- one row at a time, in a stable order
          const park = await run(repo.findPark(waitStateId));
          if (
            park?.status === "resuming" &&
            park.wake !== null &&
            park.parkStepId !== null &&
            memo.has(park.parkStepId)
          ) {
            // eslint-disable-next-line eslint/no-await-in-loop -- one row at a time, in a stable order
            await run(
              writes.markWaitStatus({
                waitStateId,
                status: settledStatus(park.wake),
              })
            );
          }
        }
        const release = await run(pass.release({ kind: "parked" }));
        if (!release.owned) {
          throw new Error("The parked pass no longer held the replay run");
        }
        current = null;
      },
    };
  };
}
