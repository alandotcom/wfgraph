/**
 * Real-DB reproduction of issue #32: concurrent publishes race the version
 * number. Gated by RUN_PUBLISH_RACE_REPRO=1. Skipped in the default suite.
 *
 * Wraps the live WorkflowRepo only in this file: after both publishers read
 * latest (and mint the same next version), a barrier releases so both inserts
 * collide on `workflow_versions_workflow_id_version_uidx`.
 */

import { appendFileSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { eq } from "drizzle-orm";
import { normalizeDatabaseConfig } from "#src/backend/lib/db/config";
import { createDatabaseSurface } from "#src/backend/lib/db/index";
import { workflows } from "#src/backend/lib/db/schema";
import { makeDatabaseLayer } from "#src/backend/lib/effect/database";
import { InternalFailure } from "#src/backend/lib/effect/failures";
import { responseFromServiceFailure } from "#src/backend/lib/http/failure-response";
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
const DEBUG_LOG = "/opt/cursor/logs/debug.log";

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

function debugLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string
) {
  appendFileSync(
    DEBUG_LOG,
    JSON.stringify({
      location,
      message,
      data,
      timestamp: Date.now(),
      hypothesisId,
    }) + "\n"
  );
}

function describeError(value: unknown): {
  message: string;
  code?: string;
  causeChain: string[];
} {
  const chain: string[] = [];
  let current: unknown = value;
  let code: string | undefined;
  for (let i = 0; i < 6 && current; i++) {
    if (current instanceof Error) {
      chain.push(`${current.name}: ${current.message}`);
      const withExtras = current as Error & {
        code?: string;
        cause?: unknown;
      };
      code ??= withExtras.code;
      current = withExtras.cause;
      continue;
    }
    if (typeof current === "object" && current !== null) {
      const obj = current as Record<string, unknown>;
      chain.push(
        JSON.stringify({
          keys: Object.keys(obj).slice(0, 12),
          code: obj.code,
          message: obj.message,
        })
      );
      code ??= typeof obj.code === "string" ? obj.code : undefined;
      current = obj.cause;
      continue;
    }
    chain.push(String(current));
    break;
  }
  return {
    message: chain[0] ?? String(value),
    code,
    causeChain: chain,
  };
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
    get arrivals() {
      return arrivals;
    },
  };
}

describe.skipIf(!runRepro)(
  "issue #32 concurrent publish race (real DB)",
  () => {
    it("two overlapping publishes mint the same version and the loser is InternalFailure/500", async () => {
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

      debugLog(
        "publish-race.repro.test.ts:setup",
        "seeded workflow for concurrent publish",
        { workflowId, name },
        "E"
      );

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
            debugLog(
              "publish-race.repro.test.ts:findLatestVersion",
              "findLatestVersion outside publish txn",
              {
                workflowId: id,
                latestVersion: row?.version ?? null,
                mintedWouldBe: (row?.version ?? 0) + 1,
              },
              "A"
            );
            debugLog(
              "publish-race.repro.test.ts:barrier",
              "waiting so peer can also mint same version",
              { workflowId: id },
              "A"
            );
            yield* Effect.promise(() => barrier.wait());
            return row;
          }),
        publishVersion: (input) =>
          Effect.gen(function* () {
            debugLog(
              "publish-race.repro.test.ts:before-insert",
              "publishVersion mint attempt",
              {
                workflowId: input.workflowId,
                versionId: input.versionId,
                mintVersion: input.mint?.version ?? null,
              },
              "B"
            );
            const published = yield* liveRepo.publishVersion(input).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  const nested = describeError(error.cause);
                  debugLog(
                    "publish-race.repro.test.ts:insert-fail",
                    "publishVersion DatabaseError (unique violation path)",
                    {
                      workflowId: input.workflowId,
                      mintVersion: input.mint?.version ?? null,
                      pgCode: nested.code ?? null,
                      causeChain: nested.causeChain,
                      isUniqueViolation:
                        nested.code === "23505" ||
                        nested.causeChain.some((line) =>
                          line.includes(
                            "workflow_versions_workflow_id_version_uidx"
                          )
                        ),
                    },
                    "C"
                  );
                })
              )
            );
            debugLog(
              "publish-race.repro.test.ts:insert-ok",
              "publishVersion succeeded",
              {
                workflowId: input.workflowId,
                version: published?.version.version ?? null,
              },
              "B"
            );
            return published;
          }),
      };

      const layer = Layer.mergeAll(
        SilentAppLoggerLayer,
        catalogLayer,
        stubIntegrationRepo({ typesByIds: () => Effect.succeed({}) }),
        Layer.succeed(WorkflowRepo, racingRepo)
      );

      // Different digests so content-dedupe cannot rescue the loser after the
      // winner commits; both still miss matching before either insert.
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
            versionId: exit.value.publishedVersionId,
          };
        }
        const failure = Option.getOrUndefined(
          Cause.findErrorOption(exit.cause)
        );
        const internal = failure instanceof InternalFailure ? failure : null;
        const httpStatus = internal
          ? responseFromServiceFailure(internal).status
          : null;
        const nested = internal?.cause
          ? describeError(internal.cause)
          : {
              message: "no-internal",
              code: undefined,
              causeChain: [] as string[],
            };
        return {
          ok: false as const,
          tag:
            failure && typeof failure === "object" && "_tag" in failure
              ? String((failure as { _tag: string })._tag)
              : "unknown",
          kind: internal?.kind ?? null,
          error: internal?.error ?? nested.message,
          httpStatus,
          pgCode: nested.code ?? null,
          causeChain: nested.causeChain,
        };
      });

      debugLog(
        "publish-race.repro.test.ts:outcomes",
        "concurrent publish exits → InternalFailure/500 path",
        { workflowId, outcomes },
        "D"
      );

      const successes = outcomes.filter((o) => o.ok);
      const failures = outcomes.filter((o) => !o.ok);

      assert.strictEqual(successes.length, 1, "exactly one publish should win");
      assert.strictEqual(failures.length, 1, "exactly one publish should lose");
      assert.strictEqual(failures[0]?.tag, "InternalFailure");
      assert.strictEqual(failures[0]?.kind, "internal");
      assert.strictEqual(failures[0]?.httpStatus, 500);
      const loserText = [
        failures[0]?.error,
        ...(failures[0]?.causeChain ?? []),
      ].join("\n");
      assert.ok(
        loserText.includes("workflow_versions_workflow_id_version_uidx") ||
          loserText.includes("unique") ||
          failures[0]?.pgCode === "23505",
        `loser should be unique violation / 23505, got: ${loserText}`
      );

      await surface.db.delete(workflows).where(eq(workflows.id, workflowId));
      await surface.close();
    });
  }
);
