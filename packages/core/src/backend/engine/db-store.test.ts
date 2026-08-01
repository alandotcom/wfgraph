/**
 * The three answers `completeRun` gives, which the engine's terminal-record
 * policy turns on. The rest of the adapter passes its input straight to the
 * repository, so this file stays on the one method that decides something.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createDbWorkflowStore } from "#src/backend/engine/db-store";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { stubRovaRuntime } from "#src/backend/lib/effect/test-layers";
import type { ExecutionRepo } from "#src/backend/services/executions/repo";

/**
 * A live store over a repository answering the case's `finishRun`. Every other
 * repository method dies, so a second query would fail the test.
 */
function storeAnswering(finishRun: ExecutionRepo["Service"]["finishRun"]) {
  return createDbWorkflowStore(
    stubRovaRuntime({ executionRepo: { finishRun } })
  );
}

const terminalWrite = {
  executionId: "exec_1",
  status: "completed",
  output: { ok: true },
} as const;

describe("completeRun", () => {
  it("answers true when the write claimed the row", async () => {
    const store = storeAnswering(() => Effect.succeed(true));

    await expect(store.completeRun(terminalWrite)).resolves.toBe(true);
  });

  it("answers false when an earlier terminal status holds the row", async () => {
    const store = storeAnswering(() => Effect.succeed(false));

    await expect(store.completeRun(terminalWrite)).resolves.toBe(false);
  });

  // The engine calls this inside the step that settles a run's outcome, where a
  // rejection would travel on and have the run recorded a second time.
  it("answers false when the database refuses the query", async () => {
    const store = storeAnswering(() =>
      Effect.fail(new DatabaseError({ cause: new Error("no connection") }))
    );

    await expect(store.completeRun(terminalWrite)).resolves.toBe(false);
  });
});
