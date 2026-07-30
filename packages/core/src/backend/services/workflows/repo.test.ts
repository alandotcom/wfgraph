/**
 * What a delivered Event's two subscriber reads ask for, and how their answers
 * are reconciled.
 *
 * The paused filter lives in a `WHERE` and the role merge lives in a database
 * callback, neither of which a service test can see: every caller stubs this
 * method whole. `drizzle-orm/pg-proxy` runs the query builder and hands each
 * statement to a callback that answers rows the case chose, so both halves are
 * reachable without a database.
 */

import { drizzle } from "drizzle-orm/pg-proxy";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { RovaDatabase } from "#src/backend/lib/db/index";
import * as schema from "#src/backend/lib/db/schema";
import { Database } from "#src/backend/lib/effect/database";
import {
  type EventSubscriber,
  WorkflowRepo,
  WorkflowRepoLayer,
} from "#src/backend/services/workflows/repo";

/** One row of the subscription-index read, in the order it selects columns. */
type NamedRow = [
  id: string,
  name: string,
  mode: string,
  role: string,
  correlationPath: string | null,
];

/** One row of the parked-run read, which has no role column to select. */
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
  const statements: { query: string; params: unknown[] }[] = [];

  const db = drizzle(
    async (query, params) => {
      statements.push({ query, params });

      if (isNamedArm(query)) {
        return { rows: answers.named ?? [] };
      }
      if (isParkedArm(query)) {
        return { rows: answers.parked ?? [] };
      }
      return { rows: [] };
    },
    { schema }
  ) as unknown as RovaDatabase;

  const databaseLayer = Layer.succeed(Database, {
    query: <A>(run: (handle: RovaDatabase) => Promise<A>) =>
      Effect.promise(() => run(db)),
  } as Database["Service"]);

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
});
