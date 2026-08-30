import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { stubDatabase } from "#src/backend/lib/effect/test-layers";
import {
  type EventSubscriber,
  WorkflowRepo,
  WorkflowRepoLayer,
} from "#src/backend/services/workflows/repo";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";

type NamedRow = [
  id: string,
  name: string,
  mode: string,
  role: string,
  correlationPath: string | null,
];
type ParkedRow = [
  id: string,
  name: string,
  mode: string,
  correlationPath: string | null,
];

function isNamedArm(query: string): boolean {
  return query.includes('"role" <>');
}

function isParkedArm(query: string): boolean {
  return query.startsWith("select distinct");
}

function subscribersHarness(answers: {
  named?: NamedRow[];
  parked?: ParkedRow[];
}) {
  const { layer: databaseLayer, statements } = stubDatabase(({ query }) => {
    if (isNamedArm(query)) return answers.named ?? [];
    if (isParkedArm(query)) return answers.parked ?? [];
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
  it("leaves paused workflows out of both reads", async () => {
    const { listSubscribers, sent } = subscribersHarness({});

    await listSubscribers("app/appointment.created");

    for (const arm of [isNamedArm, isParkedArm]) {
      const statement = sent(arm);
      expect(statement?.query).toContain('"is_paused" = ');
      expect(statement?.params).toContain(false);
    }
  });

  it("asks the index for every role but wait", async () => {
    const { listSubscribers, sent } = subscribersHarness({});

    await listSubscribers("app/appointment.created");

    expect(sent(isNamedArm)?.params).toContain("wait");
    expect(sent(isParkedArm)?.params).toContain("app/appointment.created");
  });

  it("unions the roles a workflow holds for one Event", async () => {
    const { listSubscribers } = subscribersHarness({
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

  it("names a workflow once however many runs are parked on it", async () => {
    const { listSubscribers } = subscribersHarness({
      parked: [
        ["wf_1", "Reminders", "live", "appointment.id"],
        ["wf_1", "Reminders", "live", "appointment.id"],
      ],
    });

    const subscribers = await listSubscribers("app/appointment.created");

    expect(subscribers).toHaveLength(1);
    expect(subscribers[0]?.roles).toEqual(["wait"]);
  });
});

describe("insertPublishedVersion", () => {
  const emptyGraph = createSerializedWorkflowGraph({ nodes: [], edges: [] });

  // The order matches the table's columns, because the stubbed driver returns
  // positional rows.
  const versionRow = (id: string, version: number) => [
    id,
    "wf_1",
    version,
    "published",
    JSON.stringify(emptyGraph),
    "fp",
    "digest",
    new Date(),
  ];

  function insert(version: number, expectedPublishedVersionId: string | null) {
    return Effect.gen(function* () {
      const repo = yield* WorkflowRepo;
      return yield* repo.insertPublishedVersion({
        workflowId: "wf_1",
        versionId: "ver_new",
        version,
        expectedPublishedVersionId,
        graph: emptyGraph,
        catalogFingerprint: "fp",
        graphDigest: "digest",
        draftGraph: emptyGraph,
        eventSubscriptions: [],
      });
    });
  }

  it("does not mint a version when the workflow is missing", async () => {
    const { layer: databaseLayer, statements } = stubDatabase(({ query }) => {
      if (query.startsWith("insert") && query.includes("workflow_versions")) {
        return [versionRow("ver_orphan", 1)];
      }
      return [];
    });

    const published = await Effect.runPromise(
      insert(1, null).pipe(
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

describe("findByIdWithPublishedVersionForRun", () => {
  function findForRun(workflowId: string) {
    return Effect.gen(function* () {
      const repo = yield* WorkflowRepo;
      return yield* repo.findByIdWithPublishedVersionForRun(workflowId);
    });
  }

  it("selects the workflow fields the run needs and the version graph", async () => {
    const { layer: databaseLayer, statements } = stubDatabase(() => []);

    await Effect.runPromise(
      findForRun("wf_1").pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

    const query = statements[0]?.query ?? "";
    const outerSelect = query.slice(0, query.indexOf('from "workflows"'));
    expect(outerSelect).toContain('as "id"');
    expect(outerSelect).toContain('as "name"');
    expect(outerSelect).toContain('as "mode"');
    expect(outerSelect).toContain('as "isPaused"');
    expect(outerSelect).not.toContain("graph");
    expect(query).toContain('"graph" as "graph"');
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

describe("findLatestVersion", () => {
  it("selects only the version number", async () => {
    const { layer: databaseLayer, statements } = stubDatabase(() => [[4]]);

    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepo;
        return yield* repo.findLatestVersion("wf_1");
      }).pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

    const query = statements[0]?.query ?? "";
    expect(found).toEqual({ version: 4 });
    expect(query).toContain('select "version" from "workflow_versions"');
    expect(query).not.toContain("graph");
  });
});

describe("freezeDraftSnapshot", () => {
  const emptyGraph = createSerializedWorkflowGraph({ nodes: [], edges: [] });

  function insertSnapshot() {
    return Effect.gen(function* () {
      const repo = yield* WorkflowRepo;
      return yield* repo.freezeDraftSnapshot({
        workflowId: "wf_1",
        versionId: "ver_snapshot",
        graph: emptyGraph,
        catalogFingerprint: "fp",
        graphDigest: "digest",
      });
    });
  }

  const snapshotRow = (id: string) => [
    id,
    "wf_1",
    null,
    "draft_snapshot",
    JSON.stringify(emptyGraph),
    "fp",
    "digest",
    new Date(),
  ];

  // With no existing snapshot, the lookup returns nothing, so the insert runs
  // and returns the minted row.
  function run(existing: string | null = null) {
    const { layer: databaseLayer, statements } = stubDatabase((statement) =>
      statement.query.startsWith("select")
        ? existing
          ? [snapshotRow(existing)]
          : []
        : [snapshotRow("ver_snapshot")]
    );

    return {
      statements,
      snapshot: Effect.runPromise(
        insertSnapshot().pipe(
          Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
        )
      ),
    };
  }

  // The publication pointer and the Event subscription index both describe the
  // published graph. A snapshot that changed either one would let Events start
  // an unpublished graph.
  it("writes to the versions table only", async () => {
    const { statements, snapshot } = run();
    await snapshot;

    expect(statements).toHaveLength(2);
  });
});

describe("findByIdWithDraftGraphForRun", () => {
  it("reads the draft graph alongside the columns a run needs", async () => {
    const { layer: databaseLayer, statements } = stubDatabase(() => []);

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepo;
        return yield* repo.findByIdWithDraftGraphForRun("wf_1");
      }).pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

    const query = statements[0]?.query ?? "";
    expect(query).toContain('as "graph"');
    expect(query).toContain('as "isPaused"');
    expect(query).toContain('as "mode"');
    // The query joins no published version. A draft run pins a snapshot of the
    // graph this read returns.
    expect(query).not.toContain("workflow_versions");
  });
});
