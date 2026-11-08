/**
 * A Cancel Event reaching a run its workflow started in another Published
 * mode, delivered by the database executor over native SQLite.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { useDeliveryHarness } from "#src/backend/executor/testing/delivery-fixtures";
import {
  actionNode,
  CANCEL_EVENT,
  CANCELABLE,
  delay,
  edge,
  lifecycleNode,
  START_EVENT,
  waitNode,
} from "#src/backend/executor/testing/run-fixtures";
import { usePersistenceRegistry } from "#src/backend/persistence/conformance/support";
import { createSqliteTestDatabase } from "#src/backend/persistence/sqlite-test-database";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";

/** Started: a one-hour delay. Canceled: one `test/mark`. */
const parksUntilCanceled = createSerializedWorkflowGraph({
  nodes: [
    lifecycleNode(CANCELABLE),
    waitNode("hold", delay("1h")),
    actionNode("outlet", "test/mark"),
  ],
  edges: [
    edge("entry", "hold", "started"),
    edge("entry", "outlet", "canceled"),
  ],
});

describe("a Cancel Event after a Published mode change", () => {
  const registry = usePersistenceRegistry(createSqliteTestDatabase);
  const open = useDeliveryHarness(registry.openDatabase);

  it("routes a run started in live mode to its Canceled outlet once the workflow is in test mode", async () => {
    const harness = await open();
    await harness.publish("wf_cancel", parksUntilCanceled);
    await harness.send({
      name: START_EVENT,
      data: { appointmentId: "appt_1" },
    });
    await harness.drain();
    const [parked] = await harness.runs("wf_cancel");
    if (parked === undefined) throw new Error("No run was started");

    await harness.connection.run(
      Effect.flatMap(WorkflowRepo, (workflows) =>
        workflows.updateMetadata({
          workflowId: "wf_cancel",
          updates: { mode: "test", updatedAt: new Date() },
        })
      )
    );
    await harness.send({
      name: CANCEL_EVENT,
      data: { appointmentId: "appt_1" },
    });
    await harness.drain();

    expect(parked.status).toBe("waiting");
    expect(harness.marks()).toEqual(["outlet"]);
    expect(await harness.runs("wf_cancel")).toEqual([
      { id: parked.id, status: "canceled" },
    ]);
  });
});
