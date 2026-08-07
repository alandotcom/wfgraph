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
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";

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

  function answerWhenWorkflowPresent({
    query,
  }: {
    query: string;
  }): unknown[][] {
    // Presence check before mint (columns: id only).
    if (query.startsWith("select") && query.includes('"workflows"')) {
      return [["wf_1"]];
    }
    if (query.startsWith("insert") && query.includes("workflow_versions")) {
      return [versionRow("ver_new", 1)];
    }
    if (query.startsWith("update") && query.includes("workflows")) {
      return [workflowRow("ver_new")];
    }
    return [];
  }

  // The unique index is the optimistic condition: insert only when that
  // version number is still free.
  it("claims a version number with on conflict do nothing", async () => {
    const { layer: databaseLayer, statements } = stubDatabase(
      answerWhenWorkflowPresent
    );

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
      if (query.startsWith("select") && query.includes('"workflows"')) {
        return [["wf_1"]];
      }
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

  // Soft null after a mint would commit an orphan version row. The presence
  // check runs before the insert so a missing workflow never writes one.
  it("does not mint a version when the workflow is missing", async () => {
    const { layer: databaseLayer, statements } = stubDatabase(({ query }) => {
      if (query.startsWith("insert") && query.includes("workflow_versions")) {
        return [versionRow("ver_orphan", 1)];
      }
      return [];
    });

    const published = await Effect.runPromise(
      insert(1).pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

    expect(published).toBeNull();
    expect(
      statements.some(
        (statement) =>
          statement.query.startsWith("insert") &&
          statement.query.includes("workflow_versions")
      )
    ).toBe(false);
  });
});

describe("setPublishedVersion", () => {
  // Publish reaches this path by content dedupe, which can name a version old
  // enough for the sweep to have claimed it. Reading it unlocked would let the
  // sweep delete it between the read and the update, and the update would then
  // fail the foreign key. `for key share` is the strength the sweep's
  // `for update` conflicts with, so one of the two waits for the other.
  it("locks the version it is about to point at", async () => {
    const { layer: databaseLayer, statements } = stubDatabase(() => []);

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepo;
        return yield* repo.setPublishedVersion({
          workflowId: "wf_1",
          versionId: "ver_1",
          draftGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
          eventSubscriptions: [],
        });
      }).pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

    expect(statements[0]?.query).toContain("for key share");
  });
});

describe("pruneUnreferencedVersions", () => {
  /** The claim is the only select that locks, and the delete the only write. */
  const isClaim = (query: string) => query.includes("for update");
  const isCutoff = (query: string) =>
    query.startsWith("select") && !isClaim(query);
  const isDelete = (query: string) => query.startsWith("delete");

  /**
   * `claimed` is what the claim arm answers, `deleted` what the delete arm
   * answers; leaving `deleted` off means every claimed row survived the
   * re-check, which is the ordinary case.
   */
  function pruneHarness(answers: {
    cutoffVersion?: number;
    claimed?: string[];
    deleted?: string[];
  }) {
    const { layer: databaseLayer, statements } = stubDatabase(({ query }) => {
      if (isDelete(query)) {
        return (answers.deleted ?? answers.claimed ?? []).map((id) => [id]);
      }
      if (isClaim(query)) {
        return (answers.claimed ?? []).map((id) => [id]);
      }
      return answers.cutoffVersion === undefined
        ? []
        : [[answers.cutoffVersion]];
    });

    const prune = (input?: { keepNewest?: number; limit?: number }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* WorkflowRepo;
          return yield* repo.pruneUnreferencedVersions({
            workflowId: "wf_1",
            keepNewest: input?.keepNewest ?? 10,
            limit: input?.limit ?? 50,
          });
        }).pipe(
          Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
        )
      );

    const sent = (predicate: (query: string) => boolean) =>
      statements.find((statement) => predicate(statement.query));

    return { prune, sent };
  }

  // The window is read as an offset into the version order, so the cutoff is
  // the newest version outside it and everything at or below is a candidate.
  it("takes its cutoff from the newest version outside the window", async () => {
    const { prune, sent } = pruneHarness({ cutoffVersion: 7 });

    await prune({ keepNewest: 10 });

    expect(sent(isCutoff)?.query).toContain("offset");
    expect(sent(isCutoff)?.params).toContain(10);
  });

  it("sends no claim and no delete when the workflow holds fewer versions than the window", async () => {
    const { prune, sent } = pruneHarness({});

    expect(await prune()).toEqual([]);
    expect(sent(isClaim)).toBeUndefined();
    expect(sent(isDelete)).toBeUndefined();
  });

  // `for update` is the one lock strength that conflicts with the `for key
  // share` an FK insert takes, and `skip locked` is what keeps the sweep from
  // ever blocking a run start or a publish.
  it("claims candidates for update, skipping any row another transaction holds", async () => {
    const { prune, sent } = pruneHarness({
      cutoffVersion: 7,
      claimed: ["ver_1"],
    });

    await prune();

    expect(sent(isClaim)?.query).toContain("for update");
    expect(sent(isClaim)?.query).toContain("skip locked");
  });

  // Both foreign keys act destructively: the executions one cascades and would
  // take a run's whole history, the published_version_id one sets null and
  // would silently unpublish. The claim excludes a row either could reach.
  it("leaves out a version an execution pins and the version a workflow publishes", async () => {
    const { prune, sent } = pruneHarness({
      cutoffVersion: 7,
      claimed: ["ver_1"],
    });

    await prune();

    expect(sent(isClaim)?.query).toContain('"workflow_executions"');
    expect(sent(isClaim)?.query).toContain('"workflows"');
    expect(sent(isClaim)?.query.match(/not exists/g)).toHaveLength(2);
  });

  // The sweep is per workflow, and the delete is bounded only by the ids the
  // claim answered. A claim that lost its workflow scope would hand the delete
  // every other workflow's unreferenced versions.
  it("claims only the workflow it was asked about", async () => {
    const { prune, sent } = pruneHarness({
      cutoffVersion: 7,
      claimed: ["ver_1"],
    });

    await prune();

    expect(sent(isClaim)?.query).toContain('"workflow_id" = ');
    expect(sent(isClaim)?.params).toContain("wf_1");
  });

  // The delete is a second statement and so a second snapshot under READ
  // COMMITTED. Narrowing it to the claimed ids alone would delete a row that
  // gained a run between the claim and the delete.
  it("re-checks the predicate in the delete rather than trusting the claim", async () => {
    const { prune, sent } = pruneHarness({
      cutoffVersion: 7,
      claimed: ["ver_1"],
    });

    await prune();

    expect(sent(isDelete)?.query.match(/not exists/g)).toHaveLength(2);
  });

  it("bounds one sweep to the batch it was given", async () => {
    const { prune, sent } = pruneHarness({
      cutoffVersion: 7,
      claimed: ["ver_1", "ver_2"],
    });

    await prune({ limit: 2 });

    expect(sent(isClaim)?.params).toContain(2);
    expect(sent(isDelete)?.params).toEqual(
      expect.arrayContaining(["ver_1", "ver_2"])
    );
  });

  it("sends no delete when every candidate was locked away", async () => {
    const { prune, sent } = pruneHarness({ cutoffVersion: 7, claimed: [] });

    expect(await prune()).toEqual([]);
    expect(sent(isDelete)).toBeUndefined();
  });

  // A row that gained a run since the claim fails the re-check and stays. It
  // was claimed, so reporting the claim would overstate what went.
  it("answers the ids the delete returned rather than the ids it claimed", async () => {
    const { prune } = pruneHarness({
      cutoffVersion: 7,
      claimed: ["ver_1", "ver_2"],
      deleted: ["ver_1"],
    });

    expect(await prune()).toEqual(["ver_1"]);
  });
});

describe("findByIdWithPublishedVersionForRun", () => {
  function findForRun(workflowId: string) {
    return Effect.gen(function* () {
      const repo = yield* WorkflowRepo;
      return yield* repo.findByIdWithPublishedVersionForRun(workflowId);
    });
  }

  // The delivery fan-out and the manual-start preflight read only these four
  // columns off the workflow row; the draft graph can run to megabytes and
  // neither has any use for it (#36).
  it("selects the workflow's id, name, mode and isPaused, and not its graph", async () => {
    const { layer: databaseLayer, statements } = stubDatabase(() => []);

    await Effect.runPromise(
      findForRun("wf_1").pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

    const [statement] = statements;
    expect(statement?.query).toContain('"workflows"."id"');
    expect(statement?.query).toContain('"workflows"."name"');
    expect(statement?.query).toContain('"workflows"."mode"');
    expect(statement?.query).toContain('"workflows"."is_paused"');
    expect(statement?.query).not.toContain('"workflows"."graph"');
  });

  // Preflight validates the published version's graph, not the draft, so the
  // joined `workflow_versions` row is read in full.
  it("still selects the published version's graph in full", async () => {
    const { layer: databaseLayer, statements } = stubDatabase(() => []);

    await Effect.runPromise(
      findForRun("wf_1").pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

    const [statement] = statements;
    expect(statement?.query).toContain('"workflow_versions"."graph"');
  });

  it("answers null when the workflow is gone", async () => {
    const { layer: databaseLayer } = stubDatabase(() => []);

    const found = await Effect.runPromise(
      findForRun("wf_missing").pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

    expect(found).toBeNull();
  });
});
