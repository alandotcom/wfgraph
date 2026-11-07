/**
 * A conformance case stands on a database, the connections it opens against
 * that database, and the rows it seeds first.
 *
 * A harness gives out a database rather than a path, because the concurrency
 * cases race two connections against one.
 */

import { afterAll, afterEach } from "vitest";
import { Effect, type Layer, ManagedRuntime } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { Concurrency } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  createIntegrationCipher,
  type IntegrationCipher,
} from "#src/backend/services/integrations/cipher";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type {
  WfGraphPersistenceInstance,
  WfGraphRunCapabilities,
} from "#src/backend/persistence/types";
import type { WfGraphRepositories } from "#src/backend/runtime";

export const emptyGraph = createSerializedWorkflowGraph({
  nodes: [],
  edges: [],
});

/**
 * The two `startForEntity` inputs a case passes when it is not about the new
 * run's opening entry or its schedule row: a fixed "run started" entry, and a
 * due time later than every instant a case claims at, so no claim leases the
 * run unless the case opened it due earlier.
 */
export const notYetDue = {
  startedEntry: { message: "Run started", metadata: {} },
  now: new Date("2100-01-01T00:00:00.000Z"),
};

/**
 * Records one Cancel Event arrival in the event inbox, with no idempotency
 * key, and answers its inbox id: the delivery id a Cancel claim records its
 * decision under.
 */
export function cancelArrival(now: Date = notYetDue.now) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const arrival = yield* executions.insertInboxEvent({
      name: "appointment/cancelled",
      data: {},
      connectionId: null,
      idempotencyKey: null,
      now,
    });
    return arrival.inboxId;
  });
}

/** The one key every backend seals with. */
export const conformanceCipher = createIntegrationCipher({
  key: "c".repeat(64),
});

/** One open connection: the four repositories on a runtime of its own. */
export type ConformanceConnection = {
  readonly run: ManagedRuntime.ManagedRuntime<
    WfGraphRepositories,
    never
  >["runPromise"];
  /**
   * The backend's repository Layer, over the same database handle `run`
   * uses, for a case that builds the app's whole Layer graph on it.
   */
  readonly repositories: Layer.Layer<WfGraphRepositories>;
  /** What the backend offers worker loops, as the instance supplied it. */
  readonly capabilities: WfGraphRunCapabilities;
  readonly close: () => Promise<void>;
};

/**
 * A statement `ConformanceDatabase.execute` runs: one text both backends
 * accept, or one text per backend where their column encodings differ.
 */
export type SqlStatement = string | { postgresql: string; sqlite: string };

export type ConformanceDatabase = {
  /**
   * `cipher` defaults to {@link conformanceCipher}. A case passes another to
   * reopen rows it sealed under the first, which is how a host rotating a key
   * without its old value is reproduced.
   */
  readonly open: (options?: {
    cipher?: IntegrationCipher | undefined;
  }) => Promise<ConformanceConnection>;
  /**
   * Runs one SQL statement on a connection of its own, outside the
   * repositories, the way a host sharing the database runs one. A case that
   * plays a host's insert through the documented SQL contract writes it here,
   * after the database's first `open` has migrated it.
   */
  readonly execute: (statement: SqlStatement) => Promise<void>;
  /**
   * Runs one `select` on a connection of its own, as `execute` does, and
   * answers the text of its first column in each row, such as the ids of rows
   * no repository method lists.
   */
  readonly selectIds: (statement: SqlStatement) => Promise<string[]>;
  readonly drop: () => Promise<void>;
};

/** No `drop`: a case dropping its own database would outrun the sweep. */
export type CaseDatabase = Pick<
  ConformanceDatabase,
  "open" | "execute" | "selectIds"
>;

/**
 * Sets one timestamp column to `at` on the rows `where` selects, for a case
 * that needs a row older than the clock its repository write read. PostgreSQL
 * reads the ISO text as UTC, and SQLite stores epoch milliseconds.
 */
export function setTimestamp(
  database: CaseDatabase,
  input: { table: string; column: string; where: string; at: Date }
): Promise<void> {
  const update = `update ${input.table} set ${input.column} =`;
  return database.execute({
    postgresql: `${update} '${input.at.toISOString()}' where ${input.where}`,
    sqlite: `${update} ${input.at.getTime()} where ${input.where}`,
  });
}

export type PersistenceTestRegistry = {
  /** A fresh database and the one connection most cases need. */
  readonly openConnection: () => Promise<ConformanceConnection>;
  /** A fresh database a case may open more than one connection on. */
  readonly openDatabase: () => Promise<CaseDatabase>;
};

export function connect(
  instance: WfGraphPersistenceInstance
): ConformanceConnection {
  const runtime = ManagedRuntime.make(instance.repositories);

  return {
    run: runtime.runPromise.bind(runtime),
    repositories: instance.repositories,
    capabilities: instance.capabilities,
    close: async () => {
      await runtime.dispose();
      await instance.close();
    },
  };
}

/** Call inside the `describe` it serves, so its hooks share that scope. */
export function usePersistenceRegistry(
  createDatabase: () => Promise<ConformanceDatabase>,
  /** Called once every case is done, for a harness holding something shared. */
  teardown?: () => Promise<void>
): PersistenceTestRegistry {
  const databases: ConformanceDatabase[] = [];
  const connections: ConformanceConnection[] = [];

  // Connections go back before the databases they came from. A backend that
  // drops a schema cannot do it while a pool still holds it.
  afterEach(async () => {
    await Promise.all(connections.splice(0).map((one) => one.close()));
    await Promise.all(databases.splice(0).map((one) => one.drop()));
  });

  if (teardown) {
    afterAll(teardown);
  }

  async function openDatabase(): Promise<CaseDatabase> {
    const database = await createDatabase();
    databases.push(database);

    return {
      execute: database.execute,
      selectIds: database.selectIds,
      open: async (options) => {
        const connection = await database.open(options);
        // Idempotent, because the restart case closes its own connection
        // mid-test and the `afterEach` sweep would close it again.
        let closed = false;
        const registered: ConformanceConnection = {
          run: connection.run,
          repositories: connection.repositories,
          capabilities: connection.capabilities,
          close: async () => {
            if (closed) {
              return;
            }
            closed = true;
            await connection.close();
          },
        };
        connections.push(registered);
        return registered;
      },
    };
  }

  return {
    openDatabase,
    openConnection: async () => (await openDatabase()).open(),
  };
}

/** Every case that opens a run needs one: the version id is a foreign key. */
export function seedPublishedWorkflow(
  connection: ConformanceConnection,
  options: {
    workflowId?: string | undefined;
    name?: string | undefined;
    versionId?: string | undefined;
    eventSubscriptions?: Parameters<
      WorkflowRepo["Service"]["insertPublishedVersion"]
    >[0]["eventSubscriptions"];
  } = {}
): Promise<void> {
  const workflowId = options.workflowId ?? "wf_1";
  const versionId = options.versionId ?? "ver_1";

  return connection.run(
    Effect.gen(function* () {
      const workflows = yield* WorkflowRepo;
      yield* workflows.insert({
        id: workflowId,
        name: options.name ?? "Appointments",
        graph: emptyGraph,
        eventSubscriptions: [],
      });
      yield* workflows.insertPublishedVersion({
        workflowId,
        versionId,
        version: 1,
        expectedPublishedVersionId: null,
        expectedDraftRevision: 1,
        graph: emptyGraph,
        draftGraph: emptyGraph,
        catalogFingerprint: "catalog",
        graphDigest: "digest",
        eventSubscriptions: options.eventSubscriptions ?? [],
        now: new Date(),
      });
    })
  );
}

/**
 * Publishes `ver_2` of the workflow `seedPublishedWorkflow` seeds, which the
 * Migration cases move a parked run onto.
 */
export const publishSecondVersion = Effect.gen(function* () {
  const workflows = yield* WorkflowRepo;
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
});

export type StartOptions = {
  deliveryId: string;
  entityValue?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  runMode?: "live" | "test" | undefined;
  concurrency?: Concurrency | undefined;
  workflowId?: string | undefined;
  versionId?: string | undefined;
  admissionDecisionId?: string | undefined;
};

/**
 * Tries to open a run against {@link seedPublishedWorkflow}, and answers
 * whatever it decided.
 */
export function attemptStart(
  connection: ConformanceConnection,
  options: StartOptions
) {
  return connection.run(
    Effect.gen(function* () {
      const executions = yield* ExecutionRepo;
      return yield* executions.startForEntity({
        execution: omitUndefined({
          workflowId: options.workflowId ?? "wf_1",
          workflowVersionId: options.versionId ?? "ver_1",
          startSource: "event" as const,
          runMode: options.runMode ?? "live",
          entityValue: options.entityValue ?? "appointment_1",
          entityType: options.entityType,
          entityId: options.entityId,
          deliveryId: options.deliveryId,
          input: {},
        }),
        concurrency: options.concurrency ?? "unlimited",
        supersededReason: "newer start",
        admissionDecisionId: options.admissionDecisionId,
        ...notYetDue,
      });
    })
  );
}
