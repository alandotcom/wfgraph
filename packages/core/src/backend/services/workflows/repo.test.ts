/**
 * What a delivered Event's two subscriber reads ask for, and how their answers
 * are reconciled.
 *
 * The paused filter lives in a `WHERE` and the role merge lives in a database
 * callback, neither of which a service test can see: every caller stubs this
 * method whole. Each arm is recognised by its own text, so one answer table
 * covers both reads.
 */

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { stubDatabase } from "#src/backend/lib/effect/test-layers";
import {
  type EventSubscriber,
  WorkflowRepo,
  WorkflowRepoLayer,
} from "#src/backend/services/workflows/repo";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";

/** One row of the subscription-index read, in the order it selects columns. */
type NamedRow = [
  id: string,
  name: string,
  mode: string,
  role: string,
  correlationPath: string | null,
];

/**
 * One row of the parked-run read. `correlationPath` is null when the join
 * finds no wait-role subscription for this workflow and Event, which is the
 * orphaned case: the graph no longer names the Event on any Wait node.
 */
type ParkedRow = [
  id: string,
  name: string,
  mode: string,
  correlationPath: string | null,
];

/**
 * The named arm is the only one that excludes a role, and the parked arm is the
 * only distinct select, so each is recognisable from its own text.
 */
function isNamedArm(query: string): boolean {
  return query.includes('"role" <>');
}

function isParkedArm(query: string): boolean {
  return query.startsWith("select distinct");
}

function harness(answers: { named?: NamedRow[]; parked?: ParkedRow[] }) {
  const { layer: databaseLayer, statements } = stubDatabase(({ query }) => {
    if (isNamedArm(query)) {
      return answers.named ?? [];
    }
    if (isParkedArm(query)) {
      return answers.parked ?? [];
    }
    return [];
  });

  const listSubscribers = (eventName: string): Promise<EventSubscriber[]> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepo;
        return yield* repo.listEventSubscribers(eventName);
      }).pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

  const sent = (predicate: (query: string) => boolean) =>
    statements.find((statement) => predicate(statement.query));

  return { listSubscribers, sent };
}

describe("listEventSubscribers", () => {
  // A paused workflow starts nothing and its parked runs are not reachable
  // either. Filtering in the join is what keeps a per-delivery row out of the
  // timeline, so neither arm may answer with one.
  it("leaves paused workflows out of both reads", async () => {
    const { listSubscribers, sent } = harness({});

    await listSubscribers("app/appointment.created");

    for (const arm of [isNamedArm, isParkedArm]) {
      const statement = sent(arm);
      expect(statement?.query).toContain('"is_paused" = ');
      expect(statement?.params).toContain(false);
    }
  });

  // A graph naming an Event on a Wait node with nothing parked on it is owed no
  // delivery, so the wait role is the parked read's to answer.
  it("asks the index for every role but wait", async () => {
    const { listSubscribers, sent } = harness({});

    await listSubscribers("app/appointment.created");

    expect(sent(isNamedArm)?.params).toContain("wait");
    expect(sent(isParkedArm)?.params).toContain("app/appointment.created");
  });

  // A workflow reached only by the parked read gets no start and no preflight,
  // which the fan-out decides by reading these roles.
  it("holds a workflow with only parked runs to the wait role", async () => {
    const { listSubscribers } = harness({
      parked: [["wf_2", "Reminders", "live", "appointment.id"]],
    });

    expect(await listSubscribers("app/appointment.created")).toEqual([
      {
        id: "wf_2",
        name: "Reminders",
        mode: "live",
        roles: ["wait"],
        correlationPath: "appointment.id",
      },
    ]);
  });

  it("unions the roles a workflow holds for one Event", async () => {
    const { listSubscribers } = harness({
      named: [
        ["wf_1", "Reminders", "live", "start", "appointment.id"],
        ["wf_1", "Reminders", "live", "cancel", "appointment.id"],
      ],
      parked: [["wf_1", "Reminders", "live", "appointment.id"]],
    });

    const subscribers = await listSubscribers("app/appointment.created");

    expect(subscribers).toHaveLength(1);
    expect(subscribers[0]?.roles).toEqual(["start", "cancel", "wait"]);
  });

  // Several runs of one workflow park on the same Event, and each is its own
  // row in the parked read.
  it("names a workflow once however many runs are parked on it", async () => {
    const { listSubscribers } = harness({
      parked: [
        ["wf_1", "Reminders", "live", "appointment.id"],
        ["wf_1", "Reminders", "live", "appointment.id"],
      ],
    });

    const subscribers = await listSubscribers("app/appointment.created");

    expect(subscribers).toHaveLength(1);
    expect(subscribers[0]?.roles).toEqual(["wait"]);
  });

  // An edit to the Wait node cannot orphan the runs already parked on it: the
  // run is still owed the Event it parked for, with no correlation path to
  // offer since the join finds no wait row left to read one from.
  it("still appears with no correlation path when the graph no longer names the Event", async () => {
    const { listSubscribers } = harness({
      parked: [["wf_2", "Reminders", "live", null]],
    });

    expect(await listSubscribers("app/appointment.created")).toEqual([
      {
        id: "wf_2",
        name: "Reminders",
        mode: "live",
        roles: ["wait"],
        correlationPath: null,
      },
    ]);
  });
});

describe("insertPublishedVersion", () => {
  const emptyGraph = createSerializedWorkflowGraph({ nodes: [], edges: [] });

  const workflowRow = (versionId: string) => [
    "wf_1",
    "Name",
    null,
    JSON.stringify(emptyGraph),
    false,
    "live",
    "private",
    versionId,
    new Date(),
    new Date(),
  ];

  const versionRow = (id: string, version: number) => [
    id,
    "wf_1",
    version,
    JSON.stringify(emptyGraph),
    "fp",
    "digest",
    new Date(),
  ];

  function insert(version: number) {
    return Effect.gen(function* () {
      const repo = yield* WorkflowRepo;
      return yield* repo.insertPublishedVersion({
        workflowId: "wf_1",
        versionId: "ver_new",
        version,
        graph: emptyGraph,
        catalogFingerprint: "fp",
        graphDigest: "digest",
        draftGraph: emptyGraph,
        eventSubscriptions: [],
      });
    });
  }

  // The unique index is the optimistic condition: insert only when that
  // version number is still free.
  it("claims a version number with on conflict do nothing", async () => {
    const { layer: databaseLayer, statements } = stubDatabase(({ query }) => {
      if (query.startsWith("insert") && query.includes("workflow_versions")) {
        return [versionRow("ver_new", 1)];
      }
      if (query.startsWith("update") && query.includes("workflows")) {
        return [workflowRow("ver_new")];
      }
      return [];
    });

    const published = await Effect.runPromise(
      insert(1).pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

    expect(
      published && "stale" in published ? null : published?.version.id
    ).toBe("ver_new");
    const mintInsert = statements.find(
      (statement) =>
        statement.query.startsWith("insert") &&
        statement.query.includes("workflow_versions")
    );
    expect(mintInsert?.query).toContain(
      'on conflict ("workflow_id","version") do nothing'
    );
  });

  it("answers stale when the version number was already taken", async () => {
    const { layer: databaseLayer } = stubDatabase(({ query }) => {
      if (query.startsWith("insert") && query.includes("workflow_versions")) {
        return [];
      }
      return [];
    });

    const published = await Effect.runPromise(
      insert(1).pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

    expect(published).toEqual({ stale: true });
  });

  // Soft-returning null after a successful mint would commit the version row.
  // The txn must throw (abort) so the catch outside can map to NotFound.
  it("aborts the transaction when the workflow update matches nothing after minting", async () => {
    const {
      layer: databaseLayer,
      statements,
      transactionOutcomes,
    } = stubDatabase(({ query }) => {
      if (query.startsWith("insert") && query.includes("workflow_versions")) {
        return [versionRow("ver_orphan", 1)];
      }
      if (query.startsWith("update") && query.includes("workflows")) {
        return [];
      }
      return [];
    });

    const published = await Effect.runPromise(
      insert(1).pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

    expect(published).toBeNull();
    expect(transactionOutcomes).toEqual(["threw"]);
    expect(
      statements.some(
        (statement) =>
          statement.query.startsWith("insert") &&
          statement.query.includes("workflow_versions")
      )
    ).toBe(true);
  });
});
