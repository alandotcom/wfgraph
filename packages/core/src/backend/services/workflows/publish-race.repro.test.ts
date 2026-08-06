/**
 * Real-DB regression for issue #32: concurrent publishes that mint the same
 * version number must not 500. Gated by RUN_PUBLISH_RACE_REPRO=1.
 *
 * Wraps the live WorkflowRepo only in this file: after both publishers read
 * latest (and mint the same next version), a barrier releases so both inserts
 * collide on `workflow_versions_workflow_id_version_uidx`. Optimistic mint
 * recovery must let both finishes succeed.
 */

import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { eq } from "drizzle-orm";
import { normalizeDatabaseConfig } from "#src/backend/lib/db/config";
import { createDatabaseSurface } from "#src/backend/lib/db/index";
import { workflows } from "#src/backend/lib/db/schema";
import { makeDatabaseLayer } from "#src/backend/lib/effect/database";
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
    it("overlapping publishes with different content both succeed", async () => {
      const url =
        process.env.DATABASE_URL?.trim() ||
        "postgresql://workflow:workflow@localhost:55437/workflow_builder";
      const surface = createDatabaseSurface(
        normalizeDatabaseConfig({ url, schema: "_workflows" })
      );

      const workflowId = generateId();
      const name = `race-repro-${workflowId.slice(0, 8)}`;
      await surface.db.insert(workflows).values({
        id: workflowId,
        name,
        graph: graphWith("Start A"),
      });

      const dbLayer = makeDatabaseLayer(surface.db);
      const liveRepo = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* WorkflowRepo;
        }).pipe(Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(dbLayer))))
      );

      const barrier = makeBarrier(2);

      const racingRepo: WorkflowRepo["Service"] = {
        ...liveRepo,
        findLatestVersion: (id) =>
          Effect.gen(function* () {
            const row = yield* liveRepo.findLatestVersion(id);
            // Hold both publishers on the same minted number before either
            // insert commits, so the unique index is forced to decide.
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

      const versions = [exitA, exitB].map((exit) => {
        if (!Exit.isSuccess(exit)) {
          const failure = Option.getOrUndefined(
            Cause.findErrorOption(exit.cause)
          );
          assert.fail(`publish failed: ${String(failure)}`);
        }
        return exit.value.publishedVersion;
      });

      assert.deepStrictEqual(
        [...versions].sort((a, b) => a - b),
        [1, 2]
      );

      await surface.db.delete(workflows).where(eq(workflows.id, workflowId));
      await surface.close();
    });

    it("overlapping publishes with identical content reuse one version", async () => {
      const url =
        process.env.DATABASE_URL?.trim() ||
        "postgresql://workflow:workflow@localhost:55437/workflow_builder";
      const surface = createDatabaseSurface(
        normalizeDatabaseConfig({ url, schema: "_workflows" })
      );

      const workflowId = generateId();
      const name = `race-reuse-${workflowId.slice(0, 8)}`;
      const graph = graphWith("Start");
      await surface.db.insert(workflows).values({
        id: workflowId,
        name,
        graph,
      });

      const dbLayer = makeDatabaseLayer(surface.db);
      const liveRepo = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* WorkflowRepo;
        }).pipe(Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(dbLayer))))
      );

      const barrier = makeBarrier(2);
      const racingRepo: WorkflowRepo["Service"] = {
        ...liveRepo,
        findLatestVersion: (id) =>
          Effect.gen(function* () {
            const row = yield* liveRepo.findLatestVersion(id);
            yield* Effect.promise(() => barrier.wait());
            return row;
          }),
        // Both miss the pre-txn content check so they both attempt a mint;
        // the loser recovers by reusing the winner's row.
        findVersionByContent: () => Effect.succeed(null),
      };

      const layer = Layer.mergeAll(
        SilentAppLoggerLayer,
        catalogLayer,
        stubIntegrationRepo({ typesByIds: () => Effect.succeed({}) }),
        Layer.succeed(WorkflowRepo, racingRepo)
      );

      const [exitA, exitB] = await Promise.all([
        Effect.runPromiseExit(
          publishWorkflow({ workflowId, graph }).pipe(Effect.provide(layer))
        ),
        Effect.runPromiseExit(
          publishWorkflow({ workflowId, graph }).pipe(Effect.provide(layer))
        ),
      ]);

      const results = [exitA, exitB].map((exit) => {
        if (!Exit.isSuccess(exit)) {
          assert.fail(`publish failed: ${String(exit)}`);
        }
        return {
          version: exit.value.publishedVersion,
          versionId: exit.value.publishedVersionId,
        };
      });

      assert.strictEqual(results[0]?.version, 1);
      assert.strictEqual(results[1]?.version, 1);
      assert.strictEqual(results[0]?.versionId, results[1]?.versionId);

      await surface.db.delete(workflows).where(eq(workflows.id, workflowId));
      await surface.close();
    });
  }
);
