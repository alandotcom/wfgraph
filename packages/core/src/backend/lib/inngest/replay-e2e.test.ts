/**
 * End-to-end replay check against Inngest's own execution protocol.
 *
 * The engine's replay guarantee is otherwise covered by `core-replay.test.ts`,
 * which drives a hand-written fake runtime. That proves our contract but not
 * our reading of Inngest: if the fake's memoization diverges from the real
 * thing, that suite stays green while production regresses. This test closes
 * the gap by running the actual Inngest function through `InngestTestEngine`.
 *
 * It reproduces the original defect exactly: Trigger -> Send Email -> Wait ->
 * Send Followup used to emit ["send-email", "send-email", "send-followup"]
 * because the pre-wait node re-ran when the wait resumed.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { InngestTestEngine } from "@inngest/test";
import { noopWorkflowStore } from "@/backend/lib/workflow-engine/store";
import {
  type RuntimeActionResult,
  registerRuntimeAction,
  unregisterRuntimeAction,
} from "@/shared/workflow/action-registry";
import { createSerializedWorkflowGraph } from "@/shared/workflow/graph";
import type { WorkflowNode } from "@/shared/workflow/types";

// The real function reaches for the Postgres-backed store. Persistence is not
// what this test is about, so swap in the noop adapter and keep the run off a
// database; the engine and the Inngest adapter are otherwise untouched.
mock.module("@/backend/lib/workflow-engine/db-store", () => ({
  dbWorkflowStore: noopWorkflowStore,
}));

const { createWorkflowRunRequestedFunction } =
  await import("./workflow-function");

const EMAIL_ACTION_ID = "test/e2e-email";
const FOLLOWUP_ACTION_ID = "test/e2e-followup";

function triggerNode(id: string): WorkflowNode {
  return {
    id,
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      label: "Trigger",
      type: "trigger",
      config: { triggerType: "Trigger" },
    },
  };
}

function actionNode(
  id: string,
  actionType: string,
  label: string
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label, type: "action", config: { actionType } },
  };
}

function waitNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Wait",
      type: "action",
      config: { actionType: "Wait", waitMode: "delay", waitDuration: "1h" },
    },
  };
}

/**
 * `InngestTestEngine.execute()` runs until the function resolves, but it only
 * auto-fulfils `step.run` results - a sleep never settles, so that helper would
 * hang here. Driving the executions by hand is what lets us observe the resume,
 * which is the whole point. `individualExecution` is protected, so if a future
 * @inngest/test changes this shape the cast fails loudly rather than silently
 * passing.
 */
type StepOp = { id: string; op?: string; data?: unknown; error?: unknown };
type Checkpoint = { type: string; steps?: StepOp[]; step?: StepOp };
type SingleExecution = {
  individualExecution: (
    opts: Record<string, unknown>
  ) => Promise<{ result: Checkpoint }>;
};
type MemoizedStep = { id: string; idIsHashed: true; handler: () => unknown };

function describeCheckpointError(checkpoint: Checkpoint): string {
  const raw = (checkpoint as { error?: unknown }).error;
  if (raw instanceof Error) {
    return raw.message;
  }
  return raw ? JSON.stringify(raw).slice(0, 300) : "";
}

/**
 * Runs the function the way the platform does: one request per step, carrying
 * the accumulated step state forward each time. Mirrors what `InngestTestRun`
 * does internally for `step.run`, and additionally fulfils sleeps, which the
 * test engine leaves unsettled and which is precisely the boundary under test.
 *
 * Returns the ids of every sleep it had to fulfil, so a test can assert the run
 * actually suspended rather than passing because nothing ever waited.
 */
async function driveRun(driver: SingleExecution) {
  const steps: MemoizedStep[] = [];
  const sleptAt: string[] = [];

  for (let request = 0; request < 40; request += 1) {
    const { result } = await driver.individualExecution({
      steps: [...steps],
    });

    if (result.type === "step-ran" && result.step) {
      // A step.run just executed for real; memoize its result exactly as the
      // platform would so the next request skips it.
      const ran = result.step;
      steps.push({
        id: ran.id,
        idIsHashed: true,
        handler: () => {
          if (ran.error) {
            throw ran.error;
          }
          return ran.data ?? null;
        },
      });
      continue;
    }

    if (result.type === "steps-found" && result.steps?.length) {
      // Sleeps and waits never settle on their own here. Fulfilling them is the
      // replay: the next request re-enters the handler from the top.
      for (const planned of result.steps) {
        sleptAt.push(planned.id);
        steps.push({
          id: planned.id,
          idIsHashed: true,
          handler: () => null,
        });
      }
      continue;
    }

    return {
      checkpoint: result.type,
      sleptAt,
      requests: request + 1,
      // Surfaced in the assertion message: a run that rejects early otherwise
      // shows up only as "the graph never suspended", which is a slow diagnosis.
      error: describeCheckpointError(result),
    };
  }

  throw new Error("Run did not settle within the request budget");
}

describe("replay against the real Inngest protocol", () => {
  const sideEffects: string[] = [];

  const emailAction = mock<() => RuntimeActionResult>(() => {
    sideEffects.push("send-email");
    return { success: true, data: { sent: true } };
  });
  const followupAction = mock<() => RuntimeActionResult>(() => {
    sideEffects.push("send-followup");
    return { success: true, data: { sent: true } };
  });

  beforeEach(() => {
    sideEffects.length = 0;
    registerRuntimeAction({
      id: EMAIL_ACTION_ID,
      label: "Send Email",
      description: "Records a send",
      execute: emailAction,
    });
    registerRuntimeAction({
      id: FOLLOWUP_ACTION_ID,
      label: "Send Followup",
      description: "Records a send",
      execute: followupAction,
    });
  });

  afterEach(() => {
    unregisterRuntimeAction(EMAIL_ACTION_ID);
    unregisterRuntimeAction(FOLLOWUP_ACTION_ID);
  });

  it("runs the pre-wait node once across a real suspend and resume", async () => {
    const engine = new InngestTestEngine({
      function: createWorkflowRunRequestedFunction({
        id: "replay-e2e",
        name: "Replay E2E",
        workflowId: "workflow_e2e",
      }),
      events: [
        {
          name: "workflow/run.requested",
          data: {
            graph: createSerializedWorkflowGraph({
              nodes: [
                triggerNode("trigger_1"),
                actionNode("email_1", EMAIL_ACTION_ID, "Send Email"),
                waitNode("wait_1"),
                actionNode("followup_1", FOLLOWUP_ACTION_ID, "Send Followup"),
              ],
              edges: [
                { id: "e1", source: "trigger_1", target: "email_1" },
                { id: "e2", source: "email_1", target: "wait_1" },
                { id: "e3", source: "wait_1", target: "followup_1" },
              ],
            }),
            executionId: "exec_e2e",
            workflowId: "workflow_e2e",
          },
        },
      ],
    });

    const outcome = await driveRun(engine as unknown as SingleExecution);

    // The run must actually have suspended, or this proves nothing.
    const diagnostic = JSON.stringify({ outcome, sideEffects });
    expect(outcome.checkpoint, diagnostic).toBe("function-resolved");
    expect(outcome.sleptAt.length, diagnostic).toBeGreaterThan(0);

    // The defect this guards against produced ["send-email", "send-email",
    // "send-followup"] because the pre-wait node re-ran on resume.
    expect(sideEffects.filter((e) => e === "send-email")).toHaveLength(1);
    expect(sideEffects).toEqual(["send-email", "send-followup"]);
  });
});
