import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { emptyExtensionCatalog } from "@rova/shared/extensions/catalog";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import { defineStep } from "#src/backend/extensions/steps/define-step";
import {
  BaseMiddleware,
  type TransformStepInputArgs,
} from "#src/backend/extensions/middleware";
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

    const pending = step?.({
      _context: {
        executionId: "exec_1",
        nodeId: "n1",
        nodeName: "Slow",
        nodeType: "action",
        runMode: "live",
      },
    });
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

/**
 * The whole path a host's middleware travels: the option, the merge, and the bag
 * the handler destructures it out of.
 */
describe("middleware reaching a handler", () => {
  class Prisma extends BaseMiddleware {
    readonly id = "prisma";

    override transformStepInput(
      args: TransformStepInputArgs
    ): TransformStepInputArgs {
      return { ...args, ctx: { ...args.ctx, prisma: "a client" } };
    }
  }

  const HANDLER_ACTION_ID = "test/reads-ctx";

  function readsContext() {
    const seen: Record<string, unknown> = {};
    const step = defineStep({
      label: "Reads ctx",
      description: "Records what the middleware put in its bag",
      category: "Test",
      configFields: [],
      input: Schema.Struct({}),
      output: Schema.Struct({ ok: Schema.Boolean }),
      handler: (bag) => {
        Object.assign(seen, bag);
        return { ok: true };
      },
    });

    const extensions: ExtensionSet = {
      catalog: emptyExtensionCatalog,
      stepFor: (actionId) =>
        actionId === HANDLER_ACTION_ID
          ? step.implement(HANDLER_ACTION_ID)
          : undefined,
      events: [],
      eventByName: () => undefined,
      connectionTestFor: () => undefined,
    };

    return { seen, extensions };
  }

  it("puts what a middleware added into the handler's bag", async () => {
    const { seen, extensions } = readsContext();
    const actions = createWorkflowActions(extensions, stubRovaRuntime(), [
      new Prisma(),
    ]);

    await actions.stepFor(HANDLER_ACTION_ID)?.(
      {
        _context: {
          nodeId: "n1",
          nodeName: "Reads",
          nodeType: "action",
          runMode: "live",
        },
      },
      {
        steps: { run: (_id, work) => work() },
        ctx: actions.contextFor(HANDLER_ACTION_ID),
      }
    );

    expect(seen.ctx).toEqual({ prisma: "a client" });
    // Under its own key, so a middleware cannot displace a name Rova owns.
    expect(seen.nodeId).toBe("n1");
  });

  it("answers an empty context for an app that declared none", () => {
    const { extensions } = readsContext();
    const actions = createWorkflowActions(extensions, stubRovaRuntime());

    expect(actions.contextFor(HANDLER_ACTION_ID)).toEqual({});
  });
});
