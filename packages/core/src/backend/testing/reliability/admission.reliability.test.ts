import { expect } from "vitest";
import { Schema } from "effect";
import type { JsonObject } from "@wfgraph/shared/types/json";
import * as fc from "fast-check";
import {
  admissionGraph,
  admissionGraphWithoutStart,
  START,
} from "#src/backend/testing/reliability/fixtures";
import { eventually } from "#src/backend/testing/reliability/control";
import { expectSettledExecution } from "#src/backend/testing/reliability/assertions";
import type { ReliabilityHost } from "#src/backend/testing/reliability/host";
import { reliabilityProperty } from "#src/backend/testing/reliability/property";

// A Start creates an Execution, but the caller loses the successful response.
// Change the current workflow or Entity before Inngest retries that same Start.
// The retry must finish the original Execution and run its original action once.
const changesBeforeRetry = [
  "publish",
  "remove-start",
  "ineligible",
  "unavailable",
  "pause",
] as const;
type ChangeBeforeRetry = (typeof changesBeforeRetry)[number];
const changeBeforeRetry = fc.constantFrom(...changesBeforeRetry);
const admissionScenarios = fc.record({
  changesBeforeRetry: fc.array(changeBeforeRetry, {
    minLength: 1,
    maxLength: 3,
  }),
  repeatedStartDeliveries: fc.integer({ min: 1, max: 3 }),
  originalActionMarker: fc.stringMatching(/^[a-zA-Z0-9_-]{1,12}$/),
});
reliabilityProperty(
  "committed admission survives retry",
  admissionScenarios,
  changesBeforeRetry.map((change) => ({
    changesBeforeRetry: change === "publish" ? [change, change] : [change],
    repeatedStartDeliveries: 2,
    originalActionMarker: "original",
  })),
  async (host, scenario) => {
    // Pause after admission commits. Releasing this gate will fail the response.
    const workflowId = await host.publish(
      admissionGraph(scenario.originalActionMarker)
    );
    host.faults.admission.arm({ fail: true, hold: true });
    const deliveryId = crypto.randomUUID();
    const startPayload = {
      entityId: "subject",
      marker: scenario.originalActionMarker,
    };
    await host.runtime.send(START, startPayload, deliveryId);
    await eventually(
      "committed admission boundary",
      async () => host.faults.admission.hits,
      (count) => count === 1
    );
    const committedExecution = await host.run(
      host.repo.findByDelivery({ workflowId, deliveryId })
    );
    expect(committedExecution).not.toBeNull();

    // Change current workflow or Entity state while the committed admission is paused.
    for (const [index, change] of scenario.changesBeforeRetry.entries()) {
      await applyChange(
        host,
        workflowId,
        change,
        `replacement:${scenario.originalActionMarker}:${index}`
      );
    }

    // Releasing the failure triggers an Inngest retry; also redeliver the same Start.
    host.faults.admission.release();
    for (let index = 0; index < scenario.repeatedStartDeliveries; index++)
      await host.runtime.send(START, startPayload, deliveryId);

    // Expect the original id, version and input, with exactly one original action.
    const executionId = await expectSettledExecution(
      host,
      workflowId,
      "completed"
    );
    expect(executionId).toBe(committedExecution?.id);
    const completedExecution = await host.run(
      host.repo.findSummaryById(executionId)
    );
    expect(completedExecution?.workflowVersionId).toBe(
      committedExecution?.workflowVersionId
    );
    expect(completedExecution?.input).toEqual(committedExecution?.input);
    expect(host.ledger).toEqual([{ marker: scenario.originalActionMarker }]);
    const refusedStarts = await host.run(
      host.repo.listWorkflowEvents({ workflowId, eventType: "run_refused" })
    );
    expect(refusedStarts).toEqual([]);
  }
);

async function applyChange(
  host: ReliabilityHost,
  workflowId: string,
  change: ChangeBeforeRetry,
  replacementMarker: string
) {
  switch (change) {
    case "pause":
      await host.rpc("bulkLifecycle", {
        workflowIds: [workflowId],
        action: "pause",
      });
      return;
    case "ineligible":
      host.state.active = false;
      return;
    case "unavailable":
      host.state.unavailable = true;
      return;
    case "publish":
      return publishReplacement(
        host,
        workflowId,
        admissionGraph(replacementMarker)
      );
    case "remove-start":
      return publishReplacement(
        host,
        workflowId,
        admissionGraphWithoutStart(replacementMarker)
      );
    default:
      change satisfies never;
      throw new Error("Unknown admission scenario change");
  }
}

async function publishReplacement(
  host: ReliabilityHost,
  workflowId: string,
  graph: JsonObject
) {
  const current = Schema.decodeUnknownSync(
    Schema.Struct({
      json: Schema.Struct({
        draftRevision: Schema.Number,
        publishedVersionId: Schema.NullOr(Schema.String),
      }),
    })
  )(await host.rpc("getById", { workflowId }));
  await host.rpc("publish", {
    workflowId,
    graph,
    expectedDraftRevision: current.json.draftRevision,
    expectedPublishedVersionId: current.json.publishedVersionId,
  });
}
