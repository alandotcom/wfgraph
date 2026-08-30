/**
 * What PostgreSQL decides when two connections race, which is the half of these
 * repositories a single connection cannot exercise.
 *
 * Each case opens several independent pools against one schema, so the conflict
 * is the server's to detect rather than one process serialising itself.
 */

import { expect, it, vi } from "vitest";
import { Effect } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  ExecutionRepo,
  UNSENT_RUN_GRACE_MS,
  UNSENT_RUN_RECLAIM_REASON,
} from "#src/backend/services/executions/repo";
import type {
  ConformanceConnection,
  ConformanceDatabase,
} from "#src/backend/persistence/persistence-conformance-test-support";
import {
  createPostgresTestDatabase,
  describePostgres,
} from "#src/backend/persistence/postgres-test-database";

const emptyGraph = createSerializedWorkflowGraph({ nodes: [], edges: [] });

describePostgres("PostgreSQL concurrency", () => {
  const databases: ConformanceDatabase[] = [];
  const connections: ConformanceConnection[] = [];

  const openRacers = async (count: number) => {
    const database = await createPostgresTestDatabase();
    databases.push(database);
    const opened = await Promise.all(
      Array.from({ length: count }, () => database.open())
    );
    connections.push(...opened);
    return opened;
  };

  const cleanup = async () => {
    await Promise.all(connections.splice(0).map((one) => one.close()));
    await Promise.all(databases.splice(0).map((one) => one.drop()));
  };

  const seedPublishedWorkflow = (connection: ConformanceConnection) =>
    connection.run(
      Effect.gen(function* () {
        const workflows = yield* WorkflowRepo;
        yield* workflows.insert({
          id: "wf_1",
          name: "Appointments",
          graph: emptyGraph,
          eventSubscriptions: [],
        });
        yield* workflows.insertPublishedVersion({
          workflowId: "wf_1",
          versionId: "ver_1",
          version: 1,
          expectedPublishedVersionId: null,
          graph: emptyGraph,
          draftGraph: emptyGraph,
          catalogFingerprint: "catalog",
          graphDigest: "digest",
          eventSubscriptions: [],
        });
      })
    );

  // SERIALIZABLE aborts one of two decisions that read and wrote the same
  // predicate, and startForEntity retries the whole decision when it does. Six
  // racers is enough that PostgreSQL really raises 40001; a stubbed driver
  // cannot raise it at all, which is how a retry that never fired went unseen.
  it("starts one run per entity however many deliveries race", async () => {
    try {
      const racers = await openRacers(6);
      await seedPublishedWorkflow(racers[0]!);

      const outcomes = await Promise.all(
        racers.map((connection, index) =>
          connection.run(
            Effect.gen(function* () {
              const executions = yield* ExecutionRepo;
              return yield* executions.startForEntity({
                execution: {
                  workflowId: "wf_1",
                  workflowVersionId: "ver_1",
                  startSource: "event",
                  runMode: "live",
                  entityValue: "appointment_1",
                  deliveryId: `delivery_${index}`,
                  input: {},
                },
                concurrency: "first-wins",
                supersededReason: "newer start",
              });
            })
          )
        )
      );

      expect(outcomes.filter((one) => one.status === "started")).toHaveLength(
        1
      );
      expect(outcomes.filter((one) => one.status === "refused")).toHaveLength(
        5
      );

      const rows = await racers[0]!.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return yield* executions.listByWorkflow({
            workflowId: "wf_1",
            includeSuperseded: true,
          });
        })
      );
      expect(rows).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  // newest-wins lets every start through and displaces the runs it found, so
  // the invariant is that exactly one survives and no run is displaced twice.
  it("leaves one live run per entity when newest-wins starts race", async () => {
    try {
      const racers = await openRacers(6);
      await seedPublishedWorkflow(racers[0]!);

      await Promise.all(
        racers.map((connection, index) =>
          connection.run(
            Effect.gen(function* () {
              const executions = yield* ExecutionRepo;
              return yield* executions.startForEntity({
                execution: {
                  workflowId: "wf_1",
                  workflowVersionId: "ver_1",
                  startSource: "event",
                  runMode: "live",
                  entityValue: "appointment_1",
                  deliveryId: `delivery_${index}`,
                  input: {},
                },
                concurrency: "newest-wins",
                supersededReason: "newer start",
              });
            })
          )
        )
      );

      const rows = await racers[0]!.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return yield* executions.listByWorkflow({
            workflowId: "wf_1",
            includeSuperseded: true,
          });
        })
      );

      // Every start is let through and displaces the runs it found, so the
      // invariant is the survivor: one run still live, the rest superseded
      // exactly once each.
      expect(rows).toHaveLength(6);
      expect(rows.filter((row) => row.status === "running")).toHaveLength(1);
      expect(rows.filter((row) => row.status === "superseded")).toHaveLength(5);
    } finally {
      await cleanup();
    }
  });

  // Both racers claim a version number no one holds, so both mint a row. One
  // wins the pointer; the loser has to delete the row it minted, or the table
  // keeps a version nothing published and nothing points at.
  it("leaves no orphan version when two publishes race for the pointer", async () => {
    try {
      const racers = await openRacers(2);
      await racers[0]!.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* workflows.insert({
            id: "wf_1",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
        })
      );

      const publish = (
        connection: ConformanceConnection,
        versionId: string,
        version: number
      ) =>
        connection.run(
          Effect.gen(function* () {
            const workflows = yield* WorkflowRepo;
            return yield* workflows.insertPublishedVersion({
              workflowId: "wf_1",
              versionId,
              version,
              expectedPublishedVersionId: null,
              graph: emptyGraph,
              draftGraph: emptyGraph,
              catalogFingerprint: "catalog",
              graphDigest: `digest_${version}`,
              eventSubscriptions: [],
            });
          })
        );

      const results = await Promise.all([
        publish(racers[0]!, "ver_a", 1),
        publish(racers[1]!, "ver_b", 2),
      ]);

      const won = results.filter((one) => one !== null && !("stale" in one));
      const stale = results.filter((one) => one !== null && "stale" in one);
      expect(won).toHaveLength(1);
      expect(stale).toHaveLength(1);

      const state = await racers[0]!.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          return {
            history: yield* workflows.listVersionHistoryPage({
              workflowId: "wf_1",
              limit: 10,
            }),
            workflow: yield* workflows.findById("wf_1"),
          };
        })
      );

      expect(state.history).toHaveLength(1);
      expect(state.workflow?.publishedVersionId).toBe(state.history[0]?.id);
    } finally {
      await cleanup();
    }
  });

  // Two racers claiming the same number is the other interleaving: the loser is
  // refused by the unique index before it mints anything.
  it("refuses the second publish that claims one version number", async () => {
    try {
      const racers = await openRacers(2);
      await racers[0]!.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* workflows.insert({
            id: "wf_1",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
        })
      );

      const publish = (connection: ConformanceConnection, versionId: string) =>
        connection.run(
          Effect.gen(function* () {
            const workflows = yield* WorkflowRepo;
            return yield* workflows.insertPublishedVersion({
              workflowId: "wf_1",
              versionId,
              version: 1,
              expectedPublishedVersionId: null,
              graph: emptyGraph,
              draftGraph: emptyGraph,
              catalogFingerprint: "catalog",
              graphDigest: `digest_${versionId}`,
              eventSubscriptions: [],
            });
          })
        );

      const results = await Promise.all([
        publish(racers[0]!, "ver_a"),
        publish(racers[1]!, "ver_b"),
      ]);

      expect(
        results.filter((one) => one !== null && !("stale" in one))
      ).toHaveLength(1);
      expect(
        results.filter((one) => one !== null && "stale" in one)
      ).toHaveLength(1);

      const history = await racers[0]!.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          return yield* workflows.listVersionHistoryPage({
            workflowId: "wf_1",
            limit: 10,
          });
        })
      );
      expect(history).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
  // One arrival is one run however many callers replay it: the caller is an
  // Inngest step whose retry re-runs the whole call, and `unlimited` compares
  // nothing, so the unique index on (workflow_id, delivery_id) is the only
  // thing standing between a burst of replays and a row each.
  it("opens one run per arrival when a delivery is replayed at once", async () => {
    try {
      const racers = await openRacers(6);
      await seedPublishedWorkflow(racers[0]!);

      const outcomes = await Promise.all(
        racers.map((connection) =>
          connection.run(
            Effect.gen(function* () {
              const executions = yield* ExecutionRepo;
              return yield* executions.startForEntity({
                execution: {
                  workflowId: "wf_1",
                  workflowVersionId: "ver_1",
                  startSource: "event",
                  runMode: "live",
                  entityValue: "appointment_1",
                  deliveryId: "one_delivery",
                  input: {},
                },
                concurrency: "unlimited",
                supersededReason: "newer start",
              });
            })
          )
        )
      );

      const ids = new Set(
        outcomes.map((one) =>
          one.status === "started" ? one.execution.id : one.status
        )
      );
      expect(ids.size).toBe(1);

      const rows = await racers[0]!.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return yield* executions.listByWorkflow({
            workflowId: "wf_1",
            includeSuperseded: true,
          });
        })
      );
      expect(rows).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  // A crash between the commit and the send leaves a row in flight that nothing
  // will ever drive. first-wins would otherwise defer to it forever, so a start
  // past the grace window closes it and goes. Only the clock moves here: the
  // row's own started_at is what the window is measured from.
  it("closes a run stuck before the bus, and defers to a live one beside it", async () => {
    try {
      const [connection] = await openRacers(1);
      await seedPublishedWorkflow(connection!);

      const start = (deliveryId: string) =>
        connection!.run(
          Effect.gen(function* () {
            const executions = yield* ExecutionRepo;
            return yield* executions.startForEntity({
              execution: {
                workflowId: "wf_1",
                workflowVersionId: "ver_1",
                startSource: "event",
                runMode: "live",
                entityValue: "appointment_1",
                deliveryId,
                input: {},
              },
              concurrency: "first-wins",
              supersededReason: "newer start",
            });
          })
        );

      const stuck = await start("delivery_stuck");
      if (stuck.status !== "started") {
        throw new Error("The first start was refused");
      }

      // Inside the window the stuck row still counts, so the next start defers.
      expect((await start("delivery_early")).status).toBe("refused");

      // Only Date is faked: the driver's own timers have to keep working, and
      // the comparison is `Date.now() - startedAt` against a row the database
      // stamped.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date(Date.now() + UNSENT_RUN_GRACE_MS + 1000));
        const afterGrace = await start("delivery_late");
        expect(afterGrace.status).toBe("started");
        if (afterGrace.status === "started") {
          expect(afterGrace.reclaimedExecutionIds).toEqual([
            stuck.execution.id,
          ]);
        }
      } finally {
        vi.useRealTimers();
      }

      const rows = await connection!.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return yield* executions.listByWorkflow({
            workflowId: "wf_1",
            includeSuperseded: true,
          });
        })
      );
      const reclaimed = rows.find((row) => row.id === stuck.execution.id);
      expect(reclaimed?.status).toBe("failed");
      expect(reclaimed?.error).toBe(UNSENT_RUN_RECLAIM_REASON);
    } finally {
      await cleanup();
    }
  });

  // Concurrency serializes on one entity in one mode of one workflow. A start
  // that compared more widely would refuse runs that have nothing to do with
  // each other, and a test run of the canvas would block the live one.
  it("compares only the runs of this entity, this mode and this workflow", async () => {
    try {
      const [connection] = await openRacers(1);
      await seedPublishedWorkflow(connection!);

      const start = (
        overrides: {
          entityValue?: string;
          runMode?: "live" | "test";
        },
        deliveryId: string
      ) =>
        connection!.run(
          Effect.gen(function* () {
            const executions = yield* ExecutionRepo;
            return yield* executions.startForEntity({
              execution: {
                workflowId: "wf_1",
                workflowVersionId: "ver_1",
                startSource: "event",
                runMode: overrides.runMode ?? "live",
                entityValue: overrides.entityValue ?? "appointment_1",
                deliveryId,
                input: {},
              },
              concurrency: "first-wins",
              supersededReason: "newer start",
            });
          })
        );

      expect((await start({}, "d_1")).status).toBe("started");
      expect((await start({}, "d_2")).status).toBe("refused");
      expect(
        (await start({ entityValue: "appointment_2" }, "d_3")).status
      ).toBe("started");
      expect((await start({ runMode: "test" }, "d_4")).status).toBe("started");
    } finally {
      await cleanup();
    }
  });
});
