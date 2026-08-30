/**
 * What a conformance case stands on: a database per case, the connections it
 * opens, and the seed every case needs before it can say anything.
 *
 * A harness gives out a database rather than a path or a single handle, because
 * the concurrency cases race two connections against one database and a path
 * cannot describe what that is for a backend whose isolation is a schema.
 */

import { afterAll, afterEach } from "vitest";
import { Effect, ManagedRuntime } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { Concurrency } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import {
  createIntegrationCipher,
  type IntegrationCipher,
} from "#src/backend/services/integrations/cipher";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { WfGraphPersistenceInstance } from "#src/backend/persistence/types";
import type { WfGraphRepositories } from "#src/backend/runtime";

export const emptyGraph = createSerializedWorkflowGraph({
  nodes: [],
  edges: [],
});

/**
 * The one key every backend seals with, so a config round-trip means the same
 * thing on each side.
 */
export const conformanceCipher = createIntegrationCipher({
  key: "c".repeat(64),
});

/** One open connection: the four repositories on a runtime of its own. */
export type ConformanceConnection = {
  readonly run: ManagedRuntime.ManagedRuntime<
    WfGraphRepositories,
    never
  >["runPromise"];
  readonly close: () => Promise<void>;
};

/** What a harness hands back: a database, and the way to be rid of it. */
export type ConformanceDatabase = {
  /**
   * `cipher` defaults to {@link conformanceCipher}. A case passes another to
   * reopen rows it sealed under the first, which is how a host rotating a key
   * without its old value is reproduced.
   */
  readonly open: (options?: {
    cipher?: IntegrationCipher;
  }) => Promise<ConformanceConnection>;
  readonly drop: () => Promise<void>;
};

/**
 * What a case holds. Dropping is the registry's, not the case's: a case that
 * dropped its own database would pull it out from under connections the sweep
 * still has to close.
 */
export type CaseDatabase = Pick<ConformanceDatabase, "open">;

export type PersistenceTestRegistry = {
  /** A fresh database, and the one connection most cases need. */
  readonly openConnection: () => Promise<ConformanceConnection>;
  /** A fresh database a case may open more than one connection on. */
  readonly openDatabase: () => Promise<CaseDatabase>;
};

/** The repositories of an opened backend, as a connection. */
export function connect(
  instance: WfGraphPersistenceInstance
): ConformanceConnection {
  const runtime = ManagedRuntime.make(instance.repositories);

  return {
    run: runtime.runPromise.bind(runtime),
    close: async () => {
      await runtime.dispose();
      await instance.close();
    },
  };
}

/**
 * Registers the teardown and answers what a case opens things through. Call it
 * inside the `describe` whose cases it serves, so the hook's scope matches its
 * subject.
 */
export function usePersistenceRegistry(
  createDatabase: () => Promise<ConformanceDatabase>,
  /** Called once every case is done, for a harness holding something shared. */
  teardown?: () => Promise<void>
): PersistenceTestRegistry {
  const databases: ConformanceDatabase[] = [];
  const connections: ConformanceConnection[] = [];

  // Connections go back before the databases they are checked out of, since a
  // backend that drops a schema cannot do it while a pool still holds it.
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
      open: async (options) => {
        const connection = await database.open(options);
        // Closed once however often it is asked, because a case testing what
        // survives a restart hands its own connection back mid-test and the
        // sweep above would otherwise close an already-closed handle.
        let closed = false;
        const registered: ConformanceConnection = {
          run: connection.run,
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

/**
 * A workflow with one published version, which every case that opens a run
 * needs first: `workflow_executions.workflow_version_id` is a foreign key.
 */
export function seedPublishedWorkflow(
  connection: ConformanceConnection,
  options: {
    workflowId?: string;
    name?: string;
    versionId?: string;
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
        graph: emptyGraph,
        draftGraph: emptyGraph,
        catalogFingerprint: "catalog",
        graphDigest: "digest",
        eventSubscriptions: options.eventSubscriptions ?? [],
      });
    })
  );
}

export type StartOptions = {
  deliveryId: string;
  entityValue?: string;
  runMode?: "live" | "test";
  concurrency?: Concurrency;
  workflowId?: string;
  versionId?: string;
};

/** Try to open a run against the seed above, and answer whatever it decided. */
export function attemptStart(
  connection: ConformanceConnection,
  options: StartOptions
) {
  return connection.run(
    Effect.gen(function* () {
      const executions = yield* ExecutionRepo;
      return yield* executions.startForEntity({
        execution: {
          workflowId: options.workflowId ?? "wf_1",
          workflowVersionId: options.versionId ?? "ver_1",
          startSource: "event",
          runMode: options.runMode ?? "live",
          entityValue: options.entityValue ?? "appointment_1",
          deliveryId: options.deliveryId,
          input: {},
        },
        concurrency: options.concurrency ?? "unlimited",
        supersededReason: "newer start",
      });
    })
  );
}
