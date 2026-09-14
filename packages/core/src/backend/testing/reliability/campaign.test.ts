import * as fc from "fast-check";
import { expect, test } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import {
  checkScenarios,
  withCleanup,
} from "#src/backend/testing/reliability/campaign";

test("a failure remains reportable when replay passes", async () => {
  let attempts = 0;
  const result = await checkScenarios({
    arbitrary: fc.constant({ marker: "original" }),
    parameters: { seed: 12, numRuns: 1 },
    execute: async () => {
      if (++attempts === 1) throw new Error("intermittent");
    },
  });
  expect(result.details.failed).toBe(true);
  expect(result.reproduced).toBe(false);
  expect(JSON.parse(JSON.stringify(result.details.counterexample))).toEqual([
    { marker: "original" },
  ]);
  expect(result.details.counterexamplePath).toBe("0");
});

test("a failing replay reports reproduction", async () => {
  const result = await checkScenarios({
    arbitrary: fc.constant("original"),
    parameters: { seed: 12, numRuns: 1 },
    execute: async () => {
      throw new Error("repeatable");
    },
  });
  expect(result.reproduced).toBe(true);
  expect(result.interrupted).toBe(false);
  expect(result.details.counterexample).toEqual(["original"]);
});

test("an interrupted replay that succeeds does not reproduce the failure", async () => {
  const original = new Error("intermittent");
  let attempts = 0;
  let replayFinished = false;
  const result = await checkScenarios({
    arbitrary: fc.constant("original"),
    parameters: { seed: 12, numRuns: 1 },
    shrinkTimeMs: 5,
    execute: async () => {
      if (++attempts === 1) throw original;
      await delay(30);
      replayFinished = true;
    },
  });
  expect(attempts).toBe(2);
  expect(replayFinished).toBe(true);
  expect(result.interrupted).toBe(true);
  expect(result.reproduced).toBe(false);
  expect(result.details.failed).toBe(true);
  expect(result.details.errorInstance).toBe(original);
  expect(result.details.counterexample).toEqual(["original"]);
});

test("interrupted shrinking waits for the active trial cleanup", async () => {
  let attempts = 0;
  let closed = 0;
  const result = await checkScenarios({
    arbitrary: fc.constant(1),
    parameters: { seed: 12, numRuns: 1 },
    shrinkTimeMs: 5,
    execute: async () =>
      withCleanup(
        async () => ({
          close: async () => {
            closed++;
          },
        }),
        async () => {
          if (++attempts > 1) await delay(30);
          throw new Error("failure");
        }
      ),
  });
  expect(result.details.failed).toBe(true);
  expect(result.interrupted).toBe(true);
  expect(closed).toBe(attempts);
  expect(closed).toBe(2);
});

test("cleanup errors preserve the scenario failure", async () => {
  const original = new Error("scenario");
  const cleanup = new Error("cleanup");
  const promise = withCleanup(
    async () => ({
      close: async () => {
        throw cleanup;
      },
    }),
    async () => {
      throw original;
    }
  );
  await expect(promise).rejects.toMatchObject({ errors: [original, cleanup] });
});

test("a cleanup failure fails an otherwise successful trial", async () => {
  await expect(
    withCleanup(
      async () => ({
        close: async () => {
          throw new Error("cleanup");
        },
      }),
      async () => undefined
    )
  ).rejects.toThrow("cleanup");
});
