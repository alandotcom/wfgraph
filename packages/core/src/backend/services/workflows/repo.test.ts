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

  it("holds a workflow with only parked runs to the wait role", async () => {
    const { listSubscribers } = subscribersHarness({
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

  it("keeps parked workflows when the graph no longer names their Event", async () => {
    const { listSubscribers } = subscribersHarness({
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

  function answerWhenWorkflowPresent({
    query,
  }: {
    query: string;
  }): unknown[][] {
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

  it("claims a version number with on conflict do nothing", async () => {
    const { layer: databaseLayer, statements } = stubDatabase(
      answerWhenWorkflowPresent
    );

    const published = await Effect.runPromise(
      insert(1, null).pipe(
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
    const pointerUpdate = statements.find((statement) =>
      statement.query.startsWith('update "workflows"')
    );
    expect(pointerUpdate?.query).toContain('"published_version_id" is null');
  });

  it("answers stale when the version number was already taken", async () => {
    const { layer: databaseLayer } = stubDatabase(({ query }) => {
      if (query.startsWith("select") && query.includes('"workflows"')) {
        return [["wf_1"]];
      }
      return [];
    });

    const published = await Effect.runPromise(
      insert(1, null).pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

    expect(published).toEqual({ stale: true });
  });

  it("removes its mint when the published pointer changed", async () => {
    const { layer: databaseLayer, statements } = stubDatabase(({ query }) => {
      if (query.startsWith("select") && query.includes('"workflows"')) {
        return [["wf_1"]];
      }
      if (query.startsWith("insert") && query.includes("workflow_versions")) {
        return [versionRow("ver_new", 2)];
      }
      return [];
    });

    const published = await Effect.runPromise(
      insert(2, "ver_observed").pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

    expect(published).toEqual({ stale: true });
    expect(
      statements.some((statement) =>
        statement.query.startsWith('delete from "workflow_versions"')
      )
    ).toBe(true);
  });

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

describe("listVersionHistoryPage", () => {
  const publishedAt = new Date("2026-08-03T00:00:00.000Z");

  function list(input: {
    workflowId: string;
    limit: number;
    cursor?: { version: number };
  }) {
    return Effect.gen(function* () {
      const repo = yield* WorkflowRepo;
      return yield* repo.listVersionHistoryPage(input);
    });
  }

  it("returns newest versions first and fetches one extra row", async () => {
    const { layer: databaseLayer, statements } = stubDatabase(() => [
      ["ver_3", 3, publishedAt, true],
      ["ver_2", 2, publishedAt, false],
    ]);

    const versions = await Effect.runPromise(
      list({ workflowId: "wf_1", limit: 1 }).pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

    expect(versions).toEqual([
      { id: "ver_3", version: 3, publishedAt, isCurrent: true },
      { id: "ver_2", version: 2, publishedAt, isCurrent: false },
    ]);
    expect(statements[0]?.query).toContain(
      'order by "workflow_versions"."version" desc'
    );
    expect(statements[0]?.params).toContain(2);
  });

  it("uses an exclusive cursor and scopes the page to its workflow", async () => {
    const { layer: databaseLayer, statements } = stubDatabase(() => [
      ["ver_2", 2, publishedAt, false],
    ]);

    await Effect.runPromise(
      list({
        workflowId: "wf_1",
        limit: 1,
        cursor: { version: 3 },
      }).pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

    expect(statements[0]?.query).toContain('"workflow_versions"."version" < ');
    expect(statements[0]?.params).toEqual(
      expect.arrayContaining(["wf_1", 3, 2])
    );
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
