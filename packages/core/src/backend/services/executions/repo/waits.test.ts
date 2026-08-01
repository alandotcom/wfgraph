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

describe("listWaitsForEvent", () => {
  // An event wait times out after 7 days by default, so the parked population is
  // large by construction and one page of it is what a delivery holds at a time.
  it("takes one page, ordered by the id the next page resumes from", async () => {
    const { service: database, statements } = stubDatabase();

    await Effect.runPromise(
      makeWaitsMethods(database).listWaitsForEvent({
        workflowId: "wf_1",
        eventName: "app/appointment.confirmed",
        runMode: "live",
        limit: 200,
      })
    );

    const [statement] = statements;
    expect(statement?.query).toContain('order by "workflow_wait_states"."id"');
    expect(statement?.query).toContain("limit");
    expect(statement?.params).toContain(200);
  });

  it("resumes after the last id of the page before", async () => {
    const { service: database, statements } = stubDatabase();

    await Effect.runPromise(
      makeWaitsMethods(database).listWaitsForEvent({
        workflowId: "wf_1",
        eventName: "app/appointment.confirmed",
        runMode: "live",
        limit: 200,
        afterId: "wait_9",
      })
    );

    const [statement] = statements;
    expect(statement?.query).toContain('"workflow_wait_states"."id" >');
    expect(statement?.params).toContain("wait_9");
  });

  // The runs this delivery already settled go to the query rather than to a
  // filter after it, so a superseded run never occupies a place in the page.
  it("excludes the settled runs in the statement", async () => {
    const { service: database, statements } = stubDatabase();

    await Effect.runPromise(
      makeWaitsMethods(database).listWaitsForEvent({
        workflowId: "wf_1",
        eventName: "app/appointment.confirmed",
        runMode: "live",
        limit: 200,
        excludingExecutionIds: ["exec_superseded"],
      })
    );

    const [statement] = statements;
    expect(statement?.query).toContain("not in");
    expect(statement?.params).toContain("exec_superseded");
  });

  it("asks for nothing extra when no run was settled", async () => {
    const { service: database, statements } = stubDatabase();

    await Effect.runPromise(
      makeWaitsMethods(database).listWaitsForEvent({
        workflowId: "wf_1",
        eventName: "app/appointment.confirmed",
        runMode: "live",
        limit: 200,
        excludingExecutionIds: [],
      })
    );

    expect(statements[0]?.query).not.toContain("not in");
  });
});

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
