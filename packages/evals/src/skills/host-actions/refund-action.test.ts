/**
 * Task check for the wfgraph-core/host-actions skill: a host adds a step that
 * refunds a charge through its payment provider and then emails the customer.
 * The developer task is "a refund step that never refunds twice, even when the
 * email fails and the run retries, and that refunds nothing in a Draft run".
 *
 * `expectSafeRefund` is the grader. It drives the action with `runHostAction`
 * from `@wfgraph/core/testing`, one call per pass of a run, against payment and
 * mail fakes that record each call and the idempotency key it carried. It runs
 * against the action the skill recommends and against two mistakes the skill
 * warns about, each of which it must reject.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { defineAction } from "@wfgraph/core";
import { actionData, runHostAction } from "@wfgraph/core/testing";

/** The calls a fake system received, with the key each one carried. */
type Recorded = { calls: { id: string; idempotencyKey: string }[] };

/** The payment provider and the mailer the action calls. */
type Systems = {
  payments: Recorded & {
    refund: (chargeId: string, idempotencyKey: string) => Promise<string>;
  };
  mail: Recorded & {
    send: (refundId: string, idempotencyKey: string) => Promise<void>;
  };
};

function fakeSystems(): Systems {
  const payments: Systems["payments"] = {
    calls: [],
    refund: async (chargeId, idempotencyKey) => {
      payments.calls.push({ id: chargeId, idempotencyKey });
      return await Promise.resolve(`re_${chargeId}`);
    },
  };
  const mail: Systems["mail"] = {
    calls: [],
    send: async (refundId, idempotencyKey) => {
      mail.calls.push({ id: refundId, idempotencyKey });
      await Promise.resolve();
    },
  };
  return { payments, mail };
}

const refundSchemas = {
  input: Schema.toStandardJSONSchemaV1(
    Schema.toStandardSchemaV1(Schema.Struct({ chargeId: Schema.String }))
  ),
  output: Schema.toStandardJSONSchemaV1(
    Schema.toStandardSchemaV1(
      Schema.Struct({ refundId: Schema.String, status: Schema.String })
    )
  ),
};

/**
 * The recommended action: `runMode` checked first, and each external call in
 * a `step.run` of its own, carrying the key that step is handed.
 */
function recommendedRefund(systems: Systems) {
  return defineAction({
    id: "billing/refund",
    label: "Refund Charge",
    description: "Refunds a charge and emails the customer.",
    ...refundSchemas,
    sideEffect: true,
    handler: async ({ input, runMode, step }) => {
      if (runMode === "test") {
        return { refundId: "re_test", status: "skipped" };
      }
      const refundId = await step.run("refund", ({ idempotencyKey }) =>
        systems.payments.refund(input.chargeId, idempotencyKey)
      );
      await step.run("email", async ({ idempotencyKey }) => {
        await systems.mail.send(refundId, idempotencyKey);
        return null;
      });
      return { refundId, status: "refunded" };
    },
  });
}

/**
 * A mistake: both calls in one `step.run`, so a failed email repeats the
 * refund when the step is retried.
 */
function oneStepRefund(systems: Systems) {
  return defineAction({
    id: "billing/refund",
    label: "Refund Charge",
    description: "Refunds a charge and emails the customer.",
    ...refundSchemas,
    sideEffect: true,
    handler: async ({ input, runMode, step }) => {
      if (runMode === "test") {
        return { refundId: "re_test", status: "skipped" };
      }
      const refundId = await step.run("refund-and-email", async (work) => {
        const id = await systems.payments.refund(
          input.chargeId,
          work.idempotencyKey
        );
        await systems.mail.send(id, work.idempotencyKey);
        return id;
      });
      return { refundId, status: "refunded" };
    },
  });
}

/**
 * A mistake: `sideEffect: true` taken to keep the step out of a Draft run, so
 * the handler never checks `runMode`.
 */
function noTestModeRefund(systems: Systems) {
  return defineAction({
    id: "billing/refund",
    label: "Refund Charge",
    description: "Refunds a charge and emails the customer.",
    ...refundSchemas,
    sideEffect: true,
    handler: async ({ input, step }) => {
      const refundId = await step.run("refund", ({ idempotencyKey }) =>
        systems.payments.refund(input.chargeId, idempotencyKey)
      );
      await step.run("email", async ({ idempotencyKey }) => {
        await systems.mail.send(refundId, idempotencyKey);
        return null;
      });
      return { refundId, status: "refunded" };
    },
  });
}

type RefundAction = ReturnType<typeof recommendedRefund>;

/**
 * The grader. It asserts that a Draft run refunds nothing, that a live run
 * refunds once and emails once under two different keys, that a later pass of
 * the same run calls neither system, and that the pass retrying a failed
 * email emails again without refunding again.
 */
async function expectSafeRefund(
  build: (systems: Systems) => RefundAction
): Promise<void> {
  const input = { chargeId: "ch_1" };

  const draftSystems = fakeSystems();
  await runHostAction(build(draftSystems), { input, runMode: "test" });
  expect(draftSystems.payments.calls).toHaveLength(0);

  const systems = fakeSystems();
  const action = build(systems);
  const first = await runHostAction(action, { input });
  expect(actionData(first.result)).toMatchObject({ refundId: "re_ch_1" });
  expect(systems.payments.calls).toHaveLength(1);
  expect(systems.mail.calls).toHaveLength(1);
  expect(systems.payments.calls[0]?.idempotencyKey).not.toBe(
    systems.mail.calls[0]?.idempotencyKey
  );

  const laterPass = await runHostAction(action, { input, memo: first.memo });
  expect(laterPass.handlerRan).toBe(false);
  expect(systems.payments.calls).toHaveLength(1);

  // The pass after the email failed and the executor retried it: every step
  // that finished before the last one is answered from the memo.
  const beforeEmail = Object.fromEntries(
    first.steps
      .slice(0, -1)
      .flatMap((step) => (step.ok ? [[step.id, step.value]] : []))
  );
  const retrySystems = fakeSystems();
  await runHostAction(build(retrySystems), {
    input,
    memo: { steps: beforeEmail },
  });
  expect(retrySystems.payments.calls).toHaveLength(0);
  expect(retrySystems.mail.calls).toHaveLength(1);
}

describe("wfgraph-core/host-actions task check", () => {
  it("refunds once, emails once, and refunds nothing in a Draft run", async () => {
    await expectSafeRefund(recommendedRefund);
  });

  it("rejects a handler that ignores runMode", async () => {
    await expect(expectSafeRefund(noTestModeRefund)).rejects.toThrow(
      "expected [ { id: 'ch_1', …(1) } ] to have a length of +0 but got 1"
    );
  });

  it("rejects both calls inside one step", async () => {
    // One step hands both calls one key, which the grader refuses first.
    await expect(expectSafeRefund(oneStepRefund)).rejects.toThrow(
      "expected 'execution_test:node_1:refund-and-email' not to be"
    );
  });
});
