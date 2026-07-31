import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { emptyExtensionCatalog } from "@rova/shared/extensions/catalog";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import { defineStep } from "#src/backend/extensions/steps/define-step";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { stubRovaRuntime } from "#src/backend/lib/effect/test-layers";

const SLOW_ACTION_ID = "test/slow";

/** A step that suspends the way a vendor call does, and counts its own calls. */
function slowStep() {
  const calls = { started: 0, finished: 0 };
  const step = defineStep({
    label: "Slow",
    description: "Suspends before it answers",
    category: "Test",
    configFields: [],
    input: Schema.Struct({}),
    output: Schema.Struct({ sent: Schema.Boolean }),
    handler: () =>
      Effect.gen(function* () {
        calls.started += 1;
        yield* Effect.sleep(50);
        calls.finished += 1;
        return { sent: true };
      }),
  });

  const extensions: ExtensionSet = {
    catalog: emptyExtensionCatalog,
    stepFor: (actionId) =>
      actionId === SLOW_ACTION_ID ? step.implement(SLOW_ACTION_ID) : undefined,
    connectionTestFor: () => undefined,
    eventByName: () => undefined,
    events: [],
  };

  return { calls, extensions };
}

/**
 * What a shutdown does to a step already doing its work.
 *
 * A step that lost its answer to the dispose would be run again by the durable
 * runtime's retry, sending a second SMS to record the first, so the answer has
 * to survive a dispose landing mid-handler.
 */
describe("the step the app runs", () => {
  it("answers a handler that was in flight when the runtime was disposed", async () => {
    const { calls, extensions } = slowStep();
    const runtime = stubRovaRuntime();
    const actions = createWorkflowActions(extensions, runtime);
    const step = actions.stepFor(SLOW_ACTION_ID);

    const pending = step?.({});
    await Effect.runPromise(Effect.sleep(10));
    const disposed = runtime.dispose();

    await expect(pending).resolves.toEqual({
      success: true,
      data: { sent: true },
    });
    await disposed;
    expect(calls).toEqual({ started: 1, finished: 1 });
  });

  it("rejects a step dispatched after the runtime was disposed", async () => {
    const { calls, extensions } = slowStep();
    const runtime = stubRovaRuntime();
    const actions = createWorkflowActions(extensions, runtime);
    const step = actions.stepFor(SLOW_ACTION_ID);

    await runtime.dispose();

    await expect(step?.({})).rejects.toThrow(/disposed/);
    expect(calls.started).toBe(0);
  });
});
