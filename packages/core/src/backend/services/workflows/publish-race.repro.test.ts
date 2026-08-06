/**
 * Real-DB regression for issue #32: concurrent publishes that claim the same
 * version number must not 500. The loser is a Conflict asking to refresh.
 * Gated by RUN_PUBLISH_RACE_REPRO=1.
 *
 * Wraps the live WorkflowRepo so both publishers read the same latest version
 * before either insert commits.
 */

import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { eq } from "drizzle-orm";
import { normalizeDatabaseConfig } from "#src/backend/lib/db/config";
import { createDatabaseSurface } from "#src/backend/lib/db/index";
import { workflows } from "#src/backend/lib/db/schema";
import { makeDatabaseLayer } from "#src/backend/lib/effect/database";
import { Conflict } from "#src/backend/lib/effect/failures";
import {
  SilentAppLoggerLayer,
  stubExtensionCatalog,
  stubIntegrationRepo,
} from "#src/backend/lib/effect/test-layers";
import { publishWorkflow } from "#src/backend/services/workflows/publish";
import {
  WorkflowRepo,
  WorkflowRepoLayer,
} from "#src/backend/services/workflows/repo";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";
import type { LifecycleRules } from "@rova/shared/lifecycle/lifecycle-rules";
import { generateId } from "@rova/shared/utils/id";

const runRepro = process.env.RUN_PUBLISH_RACE_REPRO === "1";

const catalogLayer = stubExtensionCatalog({
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      correlationPath: "appointment.id",
      payloadFields: [],
    },
  ],
});

const rules: LifecycleRules = {
  startEvents: ["app/appointment.created"],
  cancelEvents: [],
  concurrency: "unlimited",
};

function graphWith(label: string) {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle-1",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: {
          label,
          type: "lifecycle",
          config: { lifecycleRules: rules },
        },
      },
    ],
    edges: [],
  });
}

function makeBarrier(expected: number) {
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    wait: (): Promise<void> => {
      arrivals += 1;
      if (arrivals >= expected) release();
      return ready;
    },
  };
}

describe.skipIf(!runRepro)(
  "issue #32 concurrent publish race (real DB)",
  () => {
    it("one publish wins and the loser is Conflict (refresh)", async () => {
      const url =
        process.env.DATABASE_URL?.trim() ||
        "postgresql://workflow:workflow@localhost:55437/workflow_builder";
      const surface = createDatabaseSurface(
        normalizeDatabaseConfig({ url, schema: "_workflows" })
      );

      const workflowId = generateId();
      await surface.db.insert(workflows).values({
        id: workflowId,
        name: `race-repro-${workflowId.slice(0, 8)}`,
        graph: graphWith("Start A"),
      });

      const dbLayer = makeDatabaseLayer(surface.db);
      const liveRepo = await Effect.runPromise(
        WorkflowRepo.pipe(
          Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(dbLayer)))
        )
      );

      const barrier = makeBarrier(2);
      const racingRepo: WorkflowRepo["Service"] = {
        ...liveRepo,
        findLatestVersion: (id) =>
          Effect.gen(function* () {
            const row = yield* liveRepo.findLatestVersion(id);
            // Both read the same current version before either claim commits.
            yield* Effect.promise(() => barrier.wait());
            return row;
          }),
      };

      const layer = Layer.mergeAll(
        SilentAppLoggerLayer,
        catalogLayer,
        stubIntegrationRepo({ typesByIds: () => Effect.succeed({}) }),
        Layer.succeed(WorkflowRepo, racingRepo)
      );

      const [exitA, exitB] = await Promise.all([
        Effect.runPromiseExit(
          publishWorkflow({
            workflowId,
            graph: graphWith("Start A"),
          }).pipe(Effect.provide(layer))
        ),
        Effect.runPromiseExit(
          publishWorkflow({
            workflowId,
            graph: graphWith("Start B"),
          }).pipe(Effect.provide(layer))
        ),
      ]);

      const outcomes = [exitA, exitB].map((exit) => {
        if (Exit.isSuccess(exit)) {
          return {
            ok: true as const,
            version: exit.value.publishedVersion,
          };
        }
        const failure = Option.getOrUndefined(
          Cause.findErrorOption(exit.cause)
        );
        return {
          ok: false as const,
          conflict: failure instanceof Conflict,
          error: failure instanceof Conflict ? failure.error : String(failure),
        };
      });

      const successes = outcomes.filter((o) => o.ok);
      const failures = outcomes.filter((o) => !o.ok);

      assert.strictEqual(successes.length, 1);
      assert.strictEqual(failures.length, 1);
      assert.strictEqual(successes[0]?.version, 1);
      assert.strictEqual(failures[0]?.conflict, true);
      assert.ok(
        failures[0]?.error.includes("Refresh"),
        `expected refresh guidance, got: ${failures[0]?.error}`
      );

      await surface.db.delete(workflows).where(eq(workflows.id, workflowId));
      await surface.close();
    });
  }
);
