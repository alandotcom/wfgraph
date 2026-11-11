/**
 * `health` on what `createWfGraphApp` answers, and the readiness route built
 * on it. A check reads one row by id through `ExecutionRepo`, bounded by
 * `HEALTH_DATABASE_TIMEOUT_MS`, and reads the time of the worker loop's last
 * turn in this process. It writes nothing and never rejects: a database that
 * fails or does not answer in time is `database: false`.
 */

import { Effect } from "effect";
import type { InProcessRunner } from "#src/backend/executor/in-process-runner";
import type { WfGraphRuntime } from "#src/backend/runtime";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { overdueAfterMs } from "#src/backend/services/executions/executor-state";

/** How long the database probe waits for an answer before it reads as down. */
const HEALTH_DATABASE_TIMEOUT_MS = 5_000;

/** An id no Execution has, so the probe reads an index and finds nothing. */
const PROBE_EXECUTION_ID = "wfgraph_health_probe";

/** The worker loop this process runs, as a health check reads it. */
export type WfGraphRunnerHealth = {
  /**
   * Whether the loop finished a turn of polling and claiming recently: within
   * two poll intervals, and never less than a minute, which is how long the
   * Runs view lets a due run wait before it says no worker has claimed it.
   */
  readonly ok: boolean;
  /** When the loop last finished a turn, as an ISO string, or null before its first. */
  readonly lastTurnAt: string | null;
};

/** What `app.health()` answers. */
export type WfGraphHealth = {
  /** Whether the database answered and, when this process runs a loop, the loop is turning. */
  readonly ok: boolean;
  /** When the check ran, as an ISO string. */
  readonly checkedAt: string;
  /** Whether the database answered a one-row read in time. */
  readonly database: boolean;
  /** The worker loop in this process, or null when this process runs none. */
  readonly runner: WfGraphRunnerHealth | null;
};

/**
 * The check over `runtime`. `runner` answers the loop this process runs, or
 * undefined once it stopped; `runsLoop` says whether the process runs one at
 * all, so a stopped loop reads as not ok rather than as absent.
 */
export function createHealthCheck(input: {
  runtime: WfGraphRuntime;
  runsLoop: boolean;
  runner: () => InProcessRunner | undefined;
}): () => Promise<WfGraphHealth> {
  const { runtime, runsLoop } = input;
  const probe = Effect.flatMap(ExecutionRepo, (executions) =>
    executions.existsById(PROBE_EXECUTION_ID)
  ).pipe(Effect.timeout(HEALTH_DATABASE_TIMEOUT_MS), Effect.isSuccess);

  return async () => {
    const database = await runtime.runPromise(probe).catch(() => false);
    const now = new Date();
    const runner = runsLoop ? runnerHealth(input.runner(), now) : null;
    return {
      ok: database && (runner?.ok ?? true),
      checkedAt: now.toISOString(),
      database,
      runner,
    };
  };
}

function runnerHealth(
  runner: InProcessRunner | undefined,
  now: Date
): WfGraphRunnerHealth {
  if (runner === undefined) return { ok: false, lastTurnAt: null };
  const lastTurnAt = runner.lastTurnAt();
  const since = (lastTurnAt ?? runner.startedAt).getTime();
  return {
    ok: now.getTime() - since <= overdueAfterMs(runner.pollMs),
    lastTurnAt: lastTurnAt?.toISOString() ?? null,
  };
}

/**
 * The readiness route's body: booleans and a timestamp alone, since the route
 * answers without authentication.
 */
export function readinessBody(health: WfGraphHealth): {
  ok: boolean;
  checkedAt: string;
  database: boolean;
  runner: boolean | null;
} {
  return {
    ok: health.ok,
    checkedAt: health.checkedAt,
    database: health.database,
    runner: health.runner === null ? null : health.runner.ok,
  };
}
