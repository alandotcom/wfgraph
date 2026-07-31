/**
 * What the engine's dispatch hands a host's `execute`, and what it keeps back.
 *
 * `createAction` owns the config validation and the envelope; the seam this
 * covers is the record the engine passes in and the context read out of it.
 */

import { describe, expect, it, vi } from "vitest";
import { hostActionStep } from "#src/backend/lib/steps/host-action-step";
import { stubStepEnvironment } from "#src/backend/lib/effect/test-layers";
import type { RuntimeActionExecute } from "@rova/shared/workflow/action-registry";

const stepContext = {
  executionId: "exec_1",
  nodeId: "node_1",
  nodeName: "Notify",
  nodeType: "action",
  runMode: "live" as const,
};

const succeeds: RuntimeActionExecute = () => ({
  success: true,
  data: { ok: true },
});

function step(implementation: RuntimeActionExecute = succeeds) {
  const execute = vi.fn(implementation);
  const action = { id: "billing/notify", execute };

  return { execute, run: hostActionStep(action)(stubStepEnvironment()) };
}

describe("hostActionStep", () => {
  // An input with no context is a Rova bug rather than something a host wrote,
  // and running anyway would hand an author the node ids they were promised as
  // empty strings.
  it("fails the node rather than calling execute without a context", async () => {
    const { execute, run } = step();

    expect(await run({ to: "someone" })).toEqual({
      success: false,
      error: {
        message:
          'Action "billing/notify" was called without a step context, so the node it belongs to cannot be identified.',
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  // The connection reaches `execute` through its context, not its payload: an
  // author reads the id to look their own credentials up with.
  it("moves the connection out of the payload and into the context", async () => {
    const { execute, run } = step();

    await run({
      _context: stepContext,
      actionId: "billing/notify",
      actionType: "billing",
      integrationId: "int_9",
      to: "someone",
    });

    expect(execute).toHaveBeenCalledWith({
      payload: { actionId: "billing/notify", to: "someone" },
      context: { ...stepContext, integrationId: "int_9" },
    });
  });

  // An action belonging to no connection is the normal case for a host action,
  // and an empty string is what a config field a builder never filled in leaves
  // behind. Both read as no connection rather than as one named "".
  it("reads a blank connection as none at all", async () => {
    for (const integrationId of ["", undefined, 7]) {
      const { execute, run } = step();

      await run({ _context: stepContext, integrationId, to: "someone" });

      expect(execute.mock.calls[0]?.[0].context.integrationId).toBeUndefined();
    }
  });

  it("hands back whatever execute answered", async () => {
    const { run } = step(() =>
      Promise.resolve({ success: false, error: { message: "declined" } })
    );

    expect(await run({ _context: stepContext })).toEqual({
      success: false,
      error: { message: "declined" },
    });
  });
});
