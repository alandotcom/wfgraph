/**
 * The shape of the parked-run candidate query, which nothing else can see.
 *
 * Every caller stubs this method out, which leaves the statement as the
 * assertion. What is pinned here is the paging and the exclusion: both are what
 * keeps one arrival from materializing every run parked on a popular Event.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { stubDatabase } from "#src/backend/lib/effect/test-layers";
import { makeWaitsMethods } from "#src/backend/services/executions/repo/waits";

describe("listWaitingStatesForExecutions", () => {
  // One statement for the whole claimed set: the cancel fan-out claims every
  // in-flight run of an entity in one statement, and asking each one separately
  // queues those reads against a pool of ten.
  it("asks for every run's waits in one statement", async () => {
    const { service: database, statements } = stubDatabase();

    await Effect.runPromise(
      makeWaitsMethods(database).listWaitingStatesForExecutions([
        "exec_1",
        "exec_2",
      ])
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]?.query).toContain('"execution_id" in');
    expect(statements[0]?.params).toEqual(["exec_1", "exec_2", "waiting"]);
  });

  it("asks nothing when no run was claimed", async () => {
    const { service: database, statements } = stubDatabase();

    const parked = await Effect.runPromise(
      makeWaitsMethods(database).listWaitingStatesForExecutions([])
    );

    expect(parked.size).toBe(0);
    expect(statements).toHaveLength(0);
  });
});
