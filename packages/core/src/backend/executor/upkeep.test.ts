/**
 * `executorUpkeep`'s sweep timing over stub repositories: when the next sweep
 * falls due after a full batch, a short one, and a failed one, and which
 * sweeps run with and without a run window.
 */

import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { executorUpkeep } from "#src/backend/executor/upkeep";
import { recordingLogger } from "#src/backend/executor/testing/recorded-logger";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  stubExecutionRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import type { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";

const POLL_MS = 20;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date("2026-11-06T12:00:00.000Z");

/** The four sweeps, named by the repository method each one calls. */
type SweepName =
  | "sweepSettledInbox"
  | "sweepEndedExecutions"
  | "sweepWorkflowAuditEvents"
  | "sweepUnreferencedDraftSnapshots";

const SWEEPS: readonly SweepName[] = [
  "sweepSettledInbox",
  "sweepEndedExecutions",
  "sweepWorkflowAuditEvents",
  "sweepUnreferencedDraftSnapshots",
];

/**
 * What a stubbed sweep answers: a full batch, the batch it was given; `short`,
 * one row less; `fail`, a `DatabaseError`.
 */
type SweepAnswer = "full" | "short" | "fail";

/**
 * Stub repositories whose sweeps answer as `answers` says, `short` when it
 * names none, and record which ones ran in `called`.
 */
function sweepRepos(answers: Partial<Record<SweepName, SweepAnswer>> = {}) {
  const called: SweepName[] = [];
  const sweep =
    (name: SweepName) => (input: { olderThan: Date; limit: number }) =>
      Effect.suspend(() => {
        called.push(name);
        const answer = answers[name] ?? "short";
        if (answer === "fail") {
          return Effect.fail(
            new DatabaseError({ cause: new Error("connection lost") })
          );
        }
        return Effect.succeed(
          answer === "full" ? input.limit : input.limit - 1
        );
      });
  const layer = Layer.merge(
    stubExecutionRepo({
      sweepSettledInbox: sweep("sweepSettledInbox"),
      sweepEndedExecutions: sweep("sweepEndedExecutions"),
      sweepWorkflowAuditEvents: sweep("sweepWorkflowAuditEvents"),
    }),
    stubWorkflowRepo({
      sweepUnreferencedDraftSnapshots: sweep("sweepUnreferencedDraftSnapshots"),
    })
  );
  return { called, layer };
}

function upkeepWith(runMs: number | undefined) {
  return executorUpkeep({
    pollMs: POLL_MS,
    retention: { inboxMs: 7 * DAY_MS, runMs },
  });
}

/** `ms` after `NOW`. */
function after(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

/** Runs the sweeps due at `NOW`, failing the case when none are. */
async function sweepNow(
  upkeep: ReturnType<typeof upkeepWith>,
  layer: Layer.Layer<ExecutionRepo | WorkflowRepo>
): Promise<void> {
  const sweeps = upkeep.sweepDue(NOW);
  if (sweeps === undefined) throw new Error("No sweep was due at NOW");
  await Effect.runPromise(sweeps.pipe(Effect.provide(layer)));
}

describe("executorUpkeep", () => {
  it.each(SWEEPS)(
    "brings the next sweep forward to one poll interval when %s deletes a full batch",
    async (full) => {
      const repos = sweepRepos({ [full]: "full" });
      const upkeep = upkeepWith(DAY_MS);

      await sweepNow(upkeep, repos.layer);

      expect(upkeep.sweepDue(after(POLL_MS - 1))).toBeUndefined();
      expect(upkeep.sweepDue(after(POLL_MS))).toBeDefined();
    }
  );

  it("waits an hour after sweeps that each deleted less than a full batch", async () => {
    const repos = sweepRepos();
    const upkeep = upkeepWith(DAY_MS);

    await sweepNow(upkeep, repos.layer);

    expect(repos.called).toEqual(SWEEPS);
    expect(upkeep.sweepDue(after(POLL_MS))).toBeUndefined();
    expect(upkeep.sweepDue(after(HOUR_MS - 1))).toBeUndefined();
    expect(upkeep.sweepDue(after(HOUR_MS))).toBeDefined();
  });

  it("runs the inbox sweep alone when no run window is set", async () => {
    const repos = sweepRepos();
    const upkeep = upkeepWith(undefined);

    await sweepNow(upkeep, repos.layer);

    expect(repos.called).toEqual(["sweepSettledInbox"]);
  });

  it("logs a failing sweepEndedExecutions, runs the audit and snapshot sweeps anyway, and waits an hour", async () => {
    const repos = sweepRepos({ sweepEndedExecutions: "fail" });
    const recording = recordingLogger();
    const upkeep = upkeepWith(DAY_MS);

    await sweepNow(upkeep, Layer.merge(repos.layer, recording.layer));

    expect(repos.called).toEqual(SWEEPS);
    expect(recording.lines.map((line) => line.message)).toContain(
      "Could not delete the ended runs past the run retention window"
    );
    // A failure counts as finished, so an outage costs one try an hour.
    expect(upkeep.sweepDue(after(POLL_MS))).toBeUndefined();
    expect(upkeep.sweepDue(after(HOUR_MS))).toBeDefined();
  });

  it("starts no second sweep while one is running", () => {
    const upkeep = upkeepWith(DAY_MS);

    expect(upkeep.sweepDue(NOW)).toBeDefined();
    expect(upkeep.sweepDue(after(2 * HOUR_MS))).toBeUndefined();
  });
});
