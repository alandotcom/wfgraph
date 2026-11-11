/**
 * This suite covers what PostgreSQL decides when two connections race, the half
 * of these repositories a single connection cannot exercise.
 *
 * Each case opens several independent pools against one schema, so the conflict
 * is the server's to detect rather than one process serializing itself.
 */

import { expect, it, vi } from "vitest";
import { Effect } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  type ClaimedRun,
  ExecutionRepo,
} from "#src/backend/services/executions/repo";
import type { ConformanceConnection } from "#src/backend/persistence/persistence-conformance-test-support";
import {
  seedPublishedWorkflow,
  usePersistenceRegistry,
} from "#src/backend/persistence/persistence-conformance-test-support";
import {
  sharedPostgresTestDatabase,
  describePostgres,
  mintTestSchemaName,
  requirePostgresTestUrl,
  withAdminClient,
} from "#src/backend/persistence/postgres-test-database";

import { migrateWfGraphDatabase } from "#src/migrate";
import { wfPostgres } from "#src/backend/persistence/postgres";
import {
  connect,
  conformanceCipher,
  notYetDue,
  publishSecondVersion,
  verdict,
} from "#src/backend/persistence/conformance/support";

const emptyGraph = createSerializedWorkflowGraph({ nodes: [], edges: [] });

describePostgres("PostgreSQL concurrency", () => {
  const shared = sharedPostgresTestDatabase();
  const { openDatabase } = usePersistenceRegistry(
    shared.createDatabase,
    shared.teardown
  );

  /**
   * These are independent connections against one database, which is what
   * makes the conflict the server's to detect rather than one process
   * serializing itself.
   */
  const openRacers = async (
    count: number
  ): Promise<[ConformanceConnection, ...ConformanceConnection[]]> => {
    const database = await openDatabase();
    const [first, ...rest] = await Promise.all(
      Array.from({ length: count }, () => database.open())
    );
    if (!first) {
      throw new Error("A race wants at least one connection");
    }
    return [first, ...rest];
  };

  it("rechecks a repark version after waiting for migration locks", async () => {
    const schema = mintTestSchemaName();
    const url = requirePostgresTestUrl();
    await migrateWfGraphDatabase({ url, schema });
    const connection = connect(
      await wfPostgres({ url, schema }).open(conformanceCipher)
    );
    try {
      await seedPublishedWorkflow(connection);
      const { executionId, waitStateId } = await connection.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          const executions = yield* ExecutionRepo;
          const draft = yield* workflows.findDraftRevisionById("wf_1");
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_1",
            versionId: "ver_2",
            version: 2,
            expectedPublishedVersionId: "ver_1",
            expectedDraftRevision: draft?.draftRevision ?? 1,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "digest-2",
            eventSubscriptions: [],
            now: new Date(),
          });
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            ...notYetDue,
          });
          if (started.status !== "started") throw new Error("Start refused");
          const startedExecutionId = started.execution.id;
          const wait = yield* executions.startWait({
            executionId: startedExecutionId,
            workflowId: "wf_1",
            workflowVersionId: "ver_1",
            nodeId: "wait_1",
            nodeName: "Approval",
            side: "started",
            waitType: "event",
            resumeToken: "original",
            subscribedEvents: ["approved"],
          });
          if (!wait) throw new Error("Wait refused");
          return {
            executionId: startedExecutionId,
            waitStateId: wait.waitStateId,
          };
        })
      );
      await withAdminClient(async (client) => {
        await client.unsafe("begin");
        let repark: Promise<unknown> | undefined;
        try {
          const [backend] = await client.unsafe<{ pid: number }[]>(
            "select pg_backend_pid() as pid"
          );
          if (!backend) throw new Error("Backend not found");
          await client.unsafe(
            `select id from "${schema}".workflow_executions where id = $1 for update`,
            [executionId]
          );
          await client.unsafe(
            `select id from "${schema}".workflow_wait_states where id = $1 for update`,
            [waitStateId]
          );
          repark = connection.run(
            Effect.gen(function* () {
              const executions = yield* ExecutionRepo;
              return yield* executions.reparkWait({
                waitStateId,
                workflowVersionId: "ver_1",
                side: "started",
                waitType: "event",
                resumeToken: "stale-repark",
                waitUntil: null,
                subscribedEvents: ["approved"],
                metadata: {},
              });
            })
          );
          await vi.waitFor(async () => {
            const blocked = await withAdminClient((observer) =>
              observer.unsafe(
                "select pid from pg_stat_activity where $1::integer = any(pg_blocking_pids(pid))",
                [backend.pid]
              )
            );
            expect(blocked.length).toBeGreaterThan(0);
          });
          await client.unsafe(
            `update "${schema}".workflow_executions set workflow_version_id = 'ver_2' where id = $1`,
            [executionId]
          );
          await client.unsafe("commit");
          expect(await repark).toEqual({ ok: false, reason: "version_moved" });
        } finally {
          await client.unsafe("rollback");
          await repark;
        }
      });
    } finally {
      await connection.close();
      await withAdminClient((client) =>
        client.unsafe(`drop schema "${schema}" cascade`)
      );
    }
  });

  // A pass's fenced write takes its schedule row `for share` and then writes
  // the execution row. Deleting a workflow's runs takes the same two rows, and
  // took them in the reverse order when the schedule row went by cascade after
  // the execution row, which PostgreSQL answered with a deadlock.
  it("deletes a workflow's runs behind a fenced write without a deadlock", async () => {
    const schema = mintTestSchemaName();
    const url = requirePostgresTestUrl();
    await migrateWfGraphDatabase({ url, schema });
    const connection = connect(
      await wfPostgres({ url, schema }).open(conformanceCipher)
    );
    try {
      await seedPublishedWorkflow(connection);
      const { executionId, scheduleId } = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            ...notYetDue,
          });
          if (started.status !== "started") throw new Error("Start refused");
          const schedule = yield* executions.findSchedule({
            executionId: started.execution.id,
          });
          if (!schedule) throw new Error("The run has no schedule row");
          return {
            executionId: started.execution.id,
            scheduleId: schedule.id,
          };
        })
      );
      await withAdminClient(async (pass) => {
        await pass.unsafe("begin");
        let deletion: Promise<number> | undefined;
        try {
          const [backend] = await pass.unsafe<{ pid: number }[]>(
            "select pg_backend_pid() as pid"
          );
          if (!backend) throw new Error("Backend not found");
          // The fenced write's first statement: hold the schedule row.
          await pass.unsafe(
            `select id from "${schema}".workflow_execution_schedule where id = $1 for share`,
            [scheduleId]
          );
          deletion = connection.run(
            Effect.flatMap(ExecutionRepo, (executions) =>
              executions.deleteAllForWorkflow("wf_1")
            )
          );
          await vi.waitFor(async () => {
            const blocked = await withAdminClient((observer) =>
              observer.unsafe(
                "select pid from pg_stat_activity where $1::integer = any(pg_blocking_pids(pid))",
                [backend.pid]
              )
            );
            expect(blocked.length).toBeGreaterThan(0);
          });
          // The fenced write's own statement on the execution row, which the
          // deletion must not be holding while it waits for the schedule row.
          await pass.unsafe(
            `update "${schema}".workflow_executions set status = 'running' where id = $1`,
            [executionId]
          );
          await pass.unsafe("commit");
          expect(await deletion).toBe(1);
        } finally {
          await pass.unsafe("rollback");
          await deletion?.catch(() => undefined);
        }
      });
    } finally {
      await connection.close();
      await withAdminClient((client) =>
        client.unsafe(`drop schema "${schema}" cascade`)
      );
    }
  });

  // The run sweep locks an ended run's row and then deletes it, and the
  // cascade takes the run's audit rows. Deleting a workflow's runs takes the
  // same rows, so it locks the run rows before it deletes any audit row.
  it("deletes a workflow's runs behind the run sweep without a deadlock", async () => {
    const schema = mintTestSchemaName();
    const url = requirePostgresTestUrl();
    await migrateWfGraphDatabase({ url, schema });
    const connection = connect(
      await wfPostgres({ url, schema }).open(conformanceCipher)
    );
    try {
      await seedPublishedWorkflow(connection);
      const executionId = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            ...notYetDue,
          });
          if (started.status !== "started") throw new Error("Start refused");
          yield* executions.endRun({
            executionId: started.execution.id,
            ending: verdict("completed"),
          });
          return started.execution.id;
        })
      );
      await withAdminClient(async (sweep) => {
        await sweep.unsafe("begin");
        let deletion: Promise<number> | undefined;
        try {
          const [backend] = await sweep.unsafe<{ pid: number }[]>(
            "select pg_backend_pid() as pid"
          );
          if (!backend) throw new Error("Backend not found");
          // The sweep's subquery: hold the ended run's row.
          await sweep.unsafe(
            `select id from "${schema}".workflow_executions where id = $1 for update`,
            [executionId]
          );
          deletion = connection.run(
            Effect.flatMap(ExecutionRepo, (executions) =>
              executions.deleteAllForWorkflow("wf_1")
            )
          );
          await vi.waitFor(async () => {
            const blocked = await withAdminClient((observer) =>
              observer.unsafe(
                "select pid from pg_stat_activity where $1::integer = any(pg_blocking_pids(pid))",
                [backend.pid]
              )
            );
            expect(blocked.length).toBeGreaterThan(0);
          });
          // The sweep's delete, whose cascade takes the run's audit rows,
          // which the deletion must not be holding while it waits for the run.
          await sweep.unsafe(
            `delete from "${schema}".workflow_executions where id = $1`,
            [executionId]
          );
          await sweep.unsafe("commit");
          expect(await deletion).toBe(0);
        } finally {
          await sweep.unsafe("rollback");
          await deletion?.catch(() => undefined);
        }
      });
    } finally {
      await connection.close();
      await withAdminClient((client) =>
        client.unsafe(`drop schema "${schema}" cascade`)
      );
    }
  });

  it("allows only one graph write for a shared draft revision", async () => {
    const racers = await openRacers(2);
    await racers[0].run(
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

    const write = (connection: ConformanceConnection, contender: string) =>
      connection.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          return yield* workflows.writeDraft({
            workflowId: "wf_1",
            expectedDraftRevision: 1,
            updates: {
              name: contender,
              graph: createSerializedWorkflowGraph({
                nodes: [],
                edges: [],
                attributes: { contender },
              }),
              updatedAt: new Date(),
            },
          });
        })
      );

    const results = await Promise.all([
      write(racers[0], "First"),
      write(racers[1]!, "Second"),
    ]);
    expect(
      results.filter((result) => result.status === "updated")
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === "conflict")).toEqual([
      { status: "conflict", currentDraftRevision: 2 },
    ]);

    const stored = await racers[0].run(
      Effect.gen(function* () {
        const workflows = yield* WorkflowRepo;
        return yield* workflows.findById("wf_1");
      })
    );
    expect(stored?.draftRevision).toBe(2);
    expect(stored?.graph.attributes).toEqual({ contender: stored?.name });
  });

  // `SERIALIZABLE` aborts one of two decisions that read and wrote the same
  // predicate, and `startForEntity` retries the whole decision when it does.
  // Six racers is enough that PostgreSQL really raises `40001`. A stubbed
  // driver cannot raise it at all, which is how a retry that never fired went
  // unseen.
  it("starts one run per entity however many deliveries race", async () => {
    const racers = await openRacers(6);
    await seedPublishedWorkflow(racers[0]);

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
              ...notYetDue,
            });
          })
        )
      )
    );

    expect(outcomes.filter((one) => one.status === "started")).toHaveLength(1);
    expect(outcomes.filter((one) => one.status === "refused")).toHaveLength(5);

    const rows = await racers[0].run(
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        return yield* executions.listByWorkflow({
          workflowId: "wf_1",
          includeSuperseded: true,
        });
      })
    );
    expect(rows).toHaveLength(1);
  });

  // newest-wins lets every start through and displaces the runs it found, so
  // the invariant is that exactly one survives and no run is displaced twice.
  // Every racer writes the row the others read, so about one decision commits
  // per round of aborts and the last racer needs about one attempt per racer.
  // Twelve racers usually exhaust a retry budget sized near the burst, or one
  // whose racers back off in step, where six did so only now and then.
  it("leaves one live run per entity when newest-wins starts race", async () => {
    const racerCount = 12;
    const racers = await openRacers(racerCount);
    await seedPublishedWorkflow(racers[0]);

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
              ...notYetDue,
            });
          })
        )
      )
    );

    const rows = await racers[0].run(
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        return yield* executions.listByWorkflow({
          workflowId: "wf_1",
          includeSuperseded: true,
        });
      })
    );

    expect(rows).toHaveLength(racerCount);
    expect(rows.filter((row) => row.status === "running")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "superseded")).toHaveLength(
      racerCount - 1
    );
  });

  // Both racers claim a version number no one holds, so both mint a row. One
  // wins the pointer; the loser has to delete the row it minted, or the table
  // keeps a version nothing published and nothing points at.
  it("leaves no orphan version when two publishes race for the pointer", async () => {
    const racers = await openRacers(2);
    await racers[0].run(
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
            expectedDraftRevision: 1,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: `digest_${version}`,
            eventSubscriptions: [],
            now: new Date(),
          });
        })
      );

    const results = await Promise.all([
      publish(racers[0], "ver_a", 1),
      publish(racers[1]!, "ver_b", 2),
    ]);

    const won = results.filter((one) => one !== null && "workflow" in one);
    const refused = results.filter(
      (one) => one !== null && !("workflow" in one)
    );
    expect(won).toHaveLength(1);
    expect(refused).toHaveLength(1);

    const state = await racers[0].run(
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
  });

  // Two racers claiming the same number is the other interleaving: the loser is
  // refused by the unique index before it mints anything.
  it("refuses the second publish that claims one version number", async () => {
    const racers = await openRacers(2);
    await racers[0].run(
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
            expectedDraftRevision: 1,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: `digest_${versionId}`,
            eventSubscriptions: [],
            now: new Date(),
          });
        })
      );

    const results = await Promise.all([
      publish(racers[0], "ver_a"),
      publish(racers[1]!, "ver_b"),
    ]);

    expect(
      results.filter((one) => one !== null && "workflow" in one)
    ).toHaveLength(1);
    expect(
      results.filter((one) => one !== null && !("workflow" in one))
    ).toHaveLength(1);

    const history = await racers[0].run(
      Effect.gen(function* () {
        const workflows = yield* WorkflowRepo;
        return yield* workflows.listVersionHistoryPage({
          workflowId: "wf_1",
          limit: 10,
        });
      })
    );
    expect(history).toHaveLength(1);
  });
  // One arrival is one run however many callers replay it. The caller is a
  // delivery pass, which a retry or an expired lease runs again from the
  // start, and `unlimited` compares nothing. The unique index on `(workflow_id, delivery_id)` is the only thing
  // standing between a burst of replays and a row each.
  it("opens one run per arrival when a delivery is replayed at once", async () => {
    const racers = await openRacers(6);
    await seedPublishedWorkflow(racers[0]);

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
              ...notYetDue,
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

    const rows = await racers[0].run(
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        return yield* executions.listByWorkflow({
          workflowId: "wf_1",
          includeSuperseded: true,
        });
      })
    );
    expect(rows).toHaveLength(1);
  });

  // Concurrency serializes on one entity in one mode of one workflow. A start
  // that compared more widely would refuse runs that have nothing to do with
  // each other, and a test run of the canvas would block the live one.
  it("compares only the runs of this entity, this mode and this workflow", async () => {
    const [connection] = await openRacers(1);
    await seedPublishedWorkflow(connection);

    const start = (
      overrides: {
        entityValue?: string | undefined;
        runMode?: "live" | "test" | undefined;
      },
      deliveryId: string
    ) =>
      connection.run(
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
            ...notYetDue,
          });
        })
      );

    expect((await start({}, "d_1")).status).toBe("started");
    expect((await start({}, "d_2")).status).toBe("refused");
    expect((await start({ entityValue: "appointment_2" }, "d_3")).status).toBe(
      "started"
    );
    expect((await start({ runMode: "test" }, "d_4")).status).toBe("started");
  });

  /** A run with a schedule row, leased to one pass, parked on two Waits. */
  const leasedRunParkedTwice = (connection: ConformanceConnection, now: Date) =>
    connection.run(
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        const started = yield* executions.startForEntity({
          execution: {
            workflowId: "wf_1",
            workflowVersionId: "ver_1",
            startSource: "manual",
            runMode: "live",
            input: {},
          },
          concurrency: "unlimited",
          startedEntry: notYetDue.startedEntry,
          now,
        });
        if (started.status !== "started") throw new Error("Start refused");
        const executionId = started.execution.id;
        const claimed = yield* executions.claimDue({
          lanes: [{ kind: "run", limit: 100 }],
          workerId: "worker_1",
          leaseMs: 60_000,
          now,
        });
        const own = claimed.find(
          (row): row is ClaimedRun =>
            row.kind === "run" && row.executionId === executionId
        );
        if (!own) throw new Error("The run was not claimed");
        const parkOn = (nodeId: string, offsetMs: number) =>
          executions.startWait({
            side: "started",
            executionId,
            workflowId: "wf_1",
            nodeId,
            nodeName: nodeId,
            workflowVersionId: "ver_1",
            waitType: "event",
            resumeToken: `${executionId}-${nodeId}`,
            waitUntil: new Date(now.getTime() + offsetMs),
            subscribedEvents: ["appointment/approved"],
          });
        const woken = yield* parkOn("wait_a", 3_600_000);
        yield* parkOn("wait_b", 7_200_000);
        if (!woken) throw new Error("The park was refused");
        return {
          executionId,
          fence: {
            kind: "run" as const,
            scheduleId: own.scheduleId,
            executionId,
            ownerToken: own.ownerToken,
          },
          wokenWaitStateId: woken.waitStateId,
          wokenResumeToken: `${executionId}-wait_a`,
        };
      })
    );

  // The release and an Event's claim both lock the schedule row before
  // anything else. Without that, a release could read the wait rows before the
  // wake committed, the claim could find the row still leased and leave it,
  // and the run would sleep until another Wait's deadline with a woken branch
  // nobody runs.
  it("never leaves a run waiting while a park holds a wake no pass consumed", async () => {
    const [releaser, producer] = await openRacers(2);
    await seedPublishedWorkflow(releaser);
    const now = new Date("2026-03-01T09:00:00.000Z");

    for (let round = 0; round < 25; round += 1) {
      const run = await leasedRunParkedTwice(releaser, now);
      const [released] = await Promise.all([
        releaser.run(
          Effect.gen(function* () {
            const executions = yield* ExecutionRepo;
            return yield* executions
              .fenced(run.fence)
              .releasePass({ outcome: { kind: "parked" }, now });
          })
        ),
        producer.run(
          Effect.gen(function* () {
            const executions = yield* ExecutionRepo;
            return yield* executions.claimWaitingStateById({
              waitStateId: run.wokenWaitStateId,
              resumeToken: run.wokenResumeToken,
              eventName: "appointment/approved",
              arrival: {
                eventName: "appointment/approved",
                payload: {},
                deliveryId: `delivery_${round}`,
              },
              now,
            });
          })
        ),
      ]);
      const schedule = await releaser.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return yield* executions.findSchedule({
            executionId: run.executionId,
          });
        })
      );

      // Whichever committed first, the wake reached the schedule row: the
      // release saw it and queued the run, or the producer found the run
      // waiting and queued it.
      expect(schedule?.state, `round ${round}`).toBe("queued");
      expect(["queued", "waiting"]).toContain(released.schedule.state);
    }
  });

  // The Migration's repin is a producer too: it writes a migrate wake on each
  // park and re-queues a sleeping run. It locks the schedule row before the
  // execution row, as the release does, so the release either reads the
  // repin's wakes or commits `waiting` before the repin re-queues the run.
  it("never leaves a run waiting when a repin's migrate wakes race its release", async () => {
    const [releaser, migrator] = await openRacers(2);
    await seedPublishedWorkflow(releaser);
    await releaser.run(publishSecondVersion);
    const now = new Date("2026-03-01T09:00:00.000Z");

    for (let round = 0; round < 25; round += 1) {
      const run = await leasedRunParkedTwice(releaser, now);
      const classified = await migrator.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return yield* executions.listWaitingStates(run.executionId);
        })
      );
      const [released, moved] = await Promise.all([
        releaser.run(
          Effect.gen(function* () {
            const executions = yield* ExecutionRepo;
            return yield* executions
              .fenced(run.fence)
              .releasePass({ outcome: { kind: "parked" }, now });
          })
        ),
        migrator.run(
          Effect.gen(function* () {
            const executions = yield* ExecutionRepo;
            return yield* executions.repinVersion({
              executionId: run.executionId,
              fromVersionId: "ver_1",
              toVersionId: "ver_2",
              expectedWaitStates: classified,
              now,
            });
          })
        ),
      ]);
      const after = await releaser.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return {
            schedule: yield* executions.findSchedule({
              executionId: run.executionId,
            }),
            parks: yield* Effect.forEach(classified, (wait) =>
              executions.findPark(wait.id)
            ),
          };
        })
      );

      // The release leaves the parks alone, so the repin always moves the
      // run, and whichever committed first, its wakes reached the schedule
      // row.
      expect(moved.moved, `round ${round}`).toBe(true);
      expect(after.schedule?.state, `round ${round}`).toBe("queued");
      expect(after.parks).toMatchObject([
        { status: "resuming", wake: { kind: "migrate" } },
        { status: "resuming", wake: { kind: "migrate" } },
      ]);
      expect(["queued", "waiting"]).toContain(released.schedule.state);
    }
  });

  it("leases one due row to exactly one of two claimers", async () => {
    const [first, second] = await openRacers(2);
    await seedPublishedWorkflow(first);
    const now = new Date("2026-03-01T09:00:00.000Z");

    for (let round = 0; round < 25; round += 1) {
      const executionId = await first.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            startedEntry: notYetDue.startedEntry,
            now,
          });
          if (started.status !== "started") throw new Error("Start refused");
          return started.execution.id;
        })
      );
      const claim = (connection: ConformanceConnection, workerId: string) =>
        connection.run(
          Effect.gen(function* () {
            const executions = yield* ExecutionRepo;
            return yield* executions.claimDue({
              lanes: [{ kind: "run", limit: 1 }],
              workerId,
              leaseMs: 60_000,
              now,
            });
          })
        );

      const claims = await Promise.all([
        claim(first, "worker_a"),
        claim(second, "worker_b"),
      ]);
      const winners = claims.flat();

      expect(winners, `round ${round}`).toHaveLength(1);
      expect(winners[0]).toMatchObject({ kind: "run", executionId });
    }
  });

  /** Waits until a statement on another connection waits on backend `pid`. */
  const waitUntilBlockedBy = (pid: number) =>
    vi.waitFor(async () => {
      const blocked = await withAdminClient((observer) =>
        observer.unsafe(
          "select pid from pg_stat_activity where $1::integer = any(pg_blocking_pids(pid))",
          [pid]
        )
      );
      expect(blocked.length).toBeGreaterThan(0);
    });

  /**
   * Plays one transaction's statements on an admin connection against a schema
   * holding the published workflow `wf_1` with one cron timer, `timer_1`:
   * `holds` first, then `deleteById("wf_1")` on the repositories until it
   * waits on that transaction, then `afterBlocked`, then a commit. The
   * deletion must finish without a deadlock and leave no workflow.
   */
  const deleteWorkflowBehind = async (input: {
    holds: readonly string[];
    afterBlocked: readonly string[];
  }) => {
    const schema = mintTestSchemaName();
    const url = requirePostgresTestUrl();
    await migrateWfGraphDatabase({ url, schema });
    const connection = connect(
      await wfPostgres({ url, schema }).open(conformanceCipher)
    );
    try {
      await seedPublishedWorkflow(connection);
      await withAdminClient((client) =>
        client.unsafe(
          `insert into "${schema}".workflow_execution_schedule (id, kind, workflow_id, cron, time_zone, state, wake_at) values ('timer_1', 'cron', 'wf_1', '*/5 * * * *', 'UTC', 'waiting', now())`
        )
      );
      await withAdminClient(async (other) => {
        await other.unsafe(`set search_path to "${schema}"`);
        let deletion: Promise<void> | undefined;
        try {
          const [backend] = await other.unsafe<{ pid: number }[]>(
            "select pg_backend_pid() as pid"
          );
          if (!backend) throw new Error("Backend not found");
          for (const statement of input.holds) await other.unsafe(statement);
          deletion = connection.run(
            Effect.flatMap(WorkflowRepo, (workflows) =>
              workflows.deleteById("wf_1")
            )
          );
          await waitUntilBlockedBy(backend.pid);
          for (const statement of input.afterBlocked)
            await other.unsafe(statement);
          await other.unsafe("commit");
          await deletion;
        } finally {
          await other.unsafe("rollback");
          await deletion?.catch(() => undefined);
        }
      });
      const left = await connection.run(
        Effect.flatMap(WorkflowRepo, (workflows) => workflows.findById("wf_1"))
      );
      expect(left).toBeNull();
    } finally {
      await connection.close();
      await withAdminClient((client) =>
        client.unsafe(`drop schema "${schema}" cascade`)
      );
    }
  };

  // Publish updates the workflow row and then locks its timers. A deletion
  // that took the timers before the workflow row deadlocked against it.
  it("deletes a workflow behind a Publish rewriting its timers without a deadlock", async () => {
    await deleteWorkflowBehind({
      holds: [
        "begin",
        "update workflows set updated_at = now() where id = 'wf_1'",
      ],
      afterBlocked: [
        "select id from workflow_execution_schedule where kind = 'cron' and workflow_id = 'wf_1' order by id for update",
        "update workflow_execution_schedule set wake_at = wake_at where id = 'timer_1'",
      ],
    });
  });

  // A pass's fenced write holds its run's schedule row and then writes the
  // execution row. The workflow's delete cascades to the execution rows
  // before their schedule rows, so it locks the run schedule rows and then
  // the runs before it deletes anything.
  it("deletes a workflow behind a fenced write of one of its runs without a deadlock", async () => {
    const schema = mintTestSchemaName();
    const url = requirePostgresTestUrl();
    await migrateWfGraphDatabase({ url, schema });
    const connection = connect(
      await wfPostgres({ url, schema }).open(conformanceCipher)
    );
    try {
      await seedPublishedWorkflow(connection);
      const { executionId, scheduleId } = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            ...notYetDue,
          });
          if (started.status !== "started") throw new Error("Start refused");
          const schedule = yield* executions.findSchedule({
            executionId: started.execution.id,
          });
          if (!schedule) throw new Error("The run has no schedule row");
          return {
            executionId: started.execution.id,
            scheduleId: schedule.id,
          };
        })
      );
      await withAdminClient(async (pass) => {
        await pass.unsafe(`set search_path to "${schema}"`);
        let deletion: Promise<void> | undefined;
        try {
          const [backend] = await pass.unsafe<{ pid: number }[]>(
            "select pg_backend_pid() as pid"
          );
          if (!backend) throw new Error("Backend not found");
          await pass.unsafe("begin");
          // The fenced write's first statement: hold the schedule row.
          await pass.unsafe(
            "select id from workflow_execution_schedule where id = $1 for share",
            [scheduleId]
          );
          deletion = connection.run(
            Effect.flatMap(WorkflowRepo, (workflows) =>
              workflows.deleteById("wf_1")
            )
          );
          await waitUntilBlockedBy(backend.pid);
          // The fenced write's own statement on the execution row, which the
          // deletion must not be holding while it waits for the schedule row.
          await pass.unsafe(
            "update workflow_executions set status = 'running' where id = $1",
            [executionId]
          );
          await pass.unsafe("commit");
          await deletion;
        } finally {
          await pass.unsafe("rollback");
          await deletion?.catch(() => undefined);
        }
      });
      const left = await connection.run(
        Effect.flatMap(WorkflowRepo, (workflows) => workflows.findById("wf_1"))
      );
      expect(left).toBeNull();
    } finally {
      await connection.close();
      await withAdminClient((client) =>
        client.unsafe(`drop schema "${schema}" cascade`)
      );
    }
  });

  // A pause sets `is_paused` and then deletes the workflow's timers, in the
  // order Publish takes the same rows.
  it("deletes a workflow behind a pause deleting its timers without a deadlock", async () => {
    await deleteWorkflowBehind({
      holds: [
        "begin",
        "update workflows set is_paused = true where id = 'wf_1'",
      ],
      afterBlocked: [
        "delete from workflow_execution_schedule where kind = 'cron' and workflow_id = 'wf_1'",
      ],
    });
  });

  // A fire holds its timer row as its fence, and its run's insert then takes
  // a key-share lock on the workflow row, which the deletion's
  // `no key update` lock allows while it waits for the timer.
  it("deletes a workflow behind a fire holding its timer without a deadlock", async () => {
    await deleteWorkflowBehind({
      holds: [
        "begin isolation level serializable",
        "select id from workflow_execution_schedule where id = 'timer_1' for update",
      ],
      afterBlocked: [
        "select id from workflows where id = 'wf_1' for key share",
      ],
    });
  });

  // A fire is serializable and takes its timer row first. Publish keeps an
  // unchanged schedule's row, and a row it only locked let a fire whose
  // snapshot predated the Publish read the version it replaced, then open a
  // run on it. Publish rewrites each row it keeps, so that fire fails with
  // 40001, retries on a fresh snapshot, and finds the version moved.
  it("refuses a fire whose snapshot predates a Publish that kept its timer", async () => {
    const schema = mintTestSchemaName();
    const url = requirePostgresTestUrl();
    await migrateWfGraphDatabase({ url, schema });
    const publisher = connect(
      await wfPostgres({ url, schema }).open(conformanceCipher)
    );
    const firer = connect(
      await wfPostgres({ url, schema }).open(conformanceCipher)
    );
    const schedule = { cron: "*/5 * * * *", timeZone: "UTC" };
    const graph = createSerializedWorkflowGraph({
      nodes: [
        {
          id: "entry",
          type: "lifecycle",
          position: { x: 0, y: 0 },
          data: {
            type: "lifecycle",
            label: "Lifecycle",
            config: {
              lifecycleRules: {
                startEvents: [],
                cancelEvents: [],
                concurrency: "unlimited",
                schedules: [schedule],
              },
            },
          },
        },
      ],
      edges: [],
    });
    const publish = (version: number) =>
      Effect.gen(function* () {
        const workflows = yield* WorkflowRepo;
        const draft = yield* workflows.findDraftRevisionById("wf_1");
        yield* workflows.insertPublishedVersion({
          workflowId: "wf_1",
          versionId: `ver_${version}`,
          version,
          expectedPublishedVersionId:
            version === 1 ? null : `ver_${version - 1}`,
          expectedDraftRevision: draft?.draftRevision ?? 1,
          graph,
          draftGraph: graph,
          catalogFingerprint: "catalog",
          graphDigest: `digest-${version}`,
          eventSubscriptions: [],
          now: new Date(),
        });
      });
    try {
      await publisher.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* workflows.insert({
            id: "wf_1",
            name: "Nightly report",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          yield* publish(1);
        })
      );
      const [timer] = await withAdminClient((client) =>
        client.unsafe<{ id: string }[]>(
          `update "${schema}".workflow_execution_schedule set state = 'leased', owner_token = 'tok_1', worker_id = 'worker_1', lease_expires_at = '2100-01-01T00:00:00.000Z' where kind = 'cron' returning id`
        )
      );
      if (!timer) throw new Error("Publish wrote no timer");

      await withAdminClient(async (holder) => {
        await holder.unsafe(`set search_path to "${schema}"`);
        let republished: Promise<void> | undefined;
        let fired: Promise<unknown> | undefined;
        try {
          const [backend] = await holder.unsafe<{ pid: number }[]>(
            "select pg_backend_pid() as pid"
          );
          if (!backend) throw new Error("Backend not found");
          // Holds the timer row, so the Publish queues for it first and the
          // fire, its snapshot taken, queues behind the Publish.
          await holder.unsafe("begin");
          await holder.unsafe(
            "select id from workflow_execution_schedule where id = $1 for update",
            [timer.id]
          );
          republished = publisher.run(publish(2));
          await waitUntilBlockedBy(backend.pid);
          fired = firer.run(
            Effect.flatMap(ExecutionRepo, (executions) =>
              executions
                .fencedCron({
                  kind: "cron",
                  scheduleId: timer.id,
                  workflowId: "wf_1",
                  ownerToken: "tok_1",
                })
                .fireCronTimer({
                  schedule,
                  expected: {
                    versionId: "ver_1",
                    mode: "live",
                    schedules: [schedule],
                  },
                  start: {
                    execution: {
                      workflowId: "wf_1",
                      workflowVersionId: "ver_1",
                      startSource: "schedule",
                      runMode: "live",
                      entityValue: "workflow:wf_1",
                      input: {},
                    },
                    concurrency: "unlimited",
                    startedEntry: notYetDue.startedEntry,
                  },
                  slot: new Date("2026-03-01T09:05:00.000Z"),
                  nextWakeAt: new Date("2026-03-01T09:10:00.000Z"),
                  refusedEntry: { message: "Refused", metadata: {} },
                  now: new Date("2026-03-01T09:06:00.000Z"),
                })
            )
          );
          await vi.waitFor(async () => {
            const waiting = await withAdminClient((observer) =>
              observer.unsafe(
                "select pid from pg_stat_activity where cardinality(pg_blocking_pids(pid)) > 0 and query like '%workflow_execution_schedule%'"
              )
            );
            expect(waiting.length).toBeGreaterThanOrEqual(2);
          });
          await holder.unsafe("commit");
          await republished;
          expect(await fired).toEqual({ kind: "stale" });
        } finally {
          await holder.unsafe("rollback");
          await republished?.catch(() => undefined);
          await fired?.catch(() => undefined);
        }
      });
      const runs = await firer.run(
        Effect.flatMap(ExecutionRepo, (executions) =>
          executions.listByWorkflow({
            workflowId: "wf_1",
            includeSuperseded: true,
          })
        )
      );
      expect(runs).toEqual([]);
    } finally {
      await publisher.close();
      await firer.close();
      await withAdminClient((client) =>
        client.unsafe(`drop schema "${schema}" cascade`)
      );
    }
  });
});
