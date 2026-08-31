import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { NodeSteps } from "@wfgraph/shared/actions/step-result";
import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import { defineStep } from "#src/backend/extensions/steps/define-step";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";

const SLOW_ACTION_ID = "test/slow";

/** A step that suspends the way a vendor call does, and counts its own calls. */
function slowStep() {
  const calls = { started: 0, finished: 0 };
  const definition = defineStep({
    label: "Slow",
    description: "Suspends before it answers",
    category: "Test",
    configFields: [],
    input: Schema.Struct({}),
    output: Schema.Struct({ sent: Schema.Boolean }),
    handler: ({ step }) =>
      step.run(
        "send",
        Effect.gen(function* () {
          calls.started += 1;
          yield* Effect.sleep(50);
          calls.finished += 1;
          return { sent: true };
        })
      ),
  });

  const extensions: ExtensionSet = {
    catalog: emptyExtensionCatalog,
    stepFor: (actionId) =>
      actionId === SLOW_ACTION_ID
        ? definition.implement(SLOW_ACTION_ID)
        : undefined,
    connectionTestFor: () => undefined,
    configOptionsFor: () => undefined,
    oauthFor: () => undefined,
    webhookFor: () => undefined,
    eventByName: () => undefined,
    events: [],
  };

  return { calls, extensions };
}

/**
 * What a shutdown does to a step already doing its work.
 *
 * Disposal interrupts the outer invocation, but a handler already doing work
 * must finish and deliver its result to the durable step before the runtime
 * closes. The outer invocation may reject: Inngest retries it and replays the
 * delivered step result instead of repeating the vendor call.
 */
describe("the step the app runs", () => {
  it("delivers an in-flight handler result before the runtime is disposed", async () => {
    const { calls, extensions } = slowStep();
    const runtime = stubWfGraphRuntime();
    const actions = createWorkflowActions(extensions, runtime);
    const step = actions.stepFor(SLOW_ACTION_ID);
    if (!step) {
      throw new Error("Expected the slow action to be assembled.");
    }

    const delivered: unknown[] = [];
    const nodeSteps: NodeSteps = {
      run: async (_stepId, work) => {
        const value = await work();
        delivered.push(value);
        return value;
      },
    };
    const pending = runtime.runPromise(
      step(
        {
          _context: {
            executionId: "exec_1",
            nodeId: "n1",
            nodeName: "Slow",
            nodeType: "action",
            runMode: "live",
          },
        },
        nodeSteps
      )
    );
    await Effect.runPromise(Effect.sleep(10));
    const disposed = runtime.dispose();

    await expect(pending).rejects.toThrow(
      "All fibers interrupted without error"
    );
    await disposed;
    expect(calls).toEqual({ started: 1, finished: 1 });
    expect(delivered).toEqual([{ ok: true, value: { sent: true } }]);
  });

  it("rejects a step dispatched after the runtime was disposed", async () => {
    const { calls, extensions } = slowStep();
    const runtime = stubWfGraphRuntime();
    const actions = createWorkflowActions(extensions, runtime);
    const step = actions.stepFor(SLOW_ACTION_ID);
    if (!step) {
      throw new Error("Expected the slow action to be assembled.");
    }

    await runtime.dispose();

    await expect(runtime.runPromise(step({}))).rejects.toThrow(/disposed/);
    expect(calls.started).toBe(0);
  });
});

/**
 * What the engine reads off an action to decide how to resolve its config.
 *
 * Both sets are derived from the same field list, and nothing else says which
 * keys they hold, so a derivation that quietly answered empty would leave the
 * engine resolving every key the plain way and say nothing about it.
 */
describe("the resolution rules an action contributes", () => {
  it("names the literal keys and the JSON-object keys from the field list", () => {
    const catalog: ExtensionCatalog = {
      ...emptyExtensionCatalog,
      actions: [
        {
          id: "example/send",
          label: "Send",
          description: "Sends",
          category: "Example",
          integration: "example",
          sideEffect: true,
          configFields: [
            { key: "subject", label: "Subject", type: "template-input" },
            {
              key: "testTo",
              label: "Test address",
              type: "text",
              literal: true,
            },
            {
              key: "variables",
              label: "Variables",
              type: "provider-fields",
              optionsSource: { provider: "template-variables" },
            },
          ],
          outputFields: [],
        },
      ],
    };
    const { extensions } = slowStep();
    const actions = createWorkflowActions(
      { ...extensions, catalog },
      stubWfGraphRuntime()
    ).metadataFor("example/send");

    expect(actions?.literalConfigKeys).toEqual(["testTo"]);
    expect(actions?.templateJsonConfigShapes).toEqual([
      ["variables", "provider-fields"],
    ]);
  });
});
