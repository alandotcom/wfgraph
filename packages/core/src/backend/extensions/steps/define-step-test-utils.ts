/**
 * Shared fixtures for defineStep suites.
 */

import { Effect, Schema } from "effect";
import { vi } from "vitest";
import type { NodeSteps } from "@wfgraph/shared/actions/step-result";
import { stubStepEnvironment } from "#src/backend/lib/effect/test-layers";
import type { StepEffect } from "#src/backend/extensions/steps/step-runner";

// The one thing a step asks the app for is its integration's credentials, which
// reach a database in production. That is the seam this file replaces; the run
// log rows belong to the engine and are pinned there.
export const credentialsFor = vi.fn(() => Effect.succeed({ API_KEY: "k" }));
export const runner = stubStepEnvironment({ credentialsFor });

export function runStep(step: StepEffect) {
  return (input: Record<string, unknown>, steps?: NodeSteps) =>
    Effect.runPromise(step(input, steps));
}

export const input = Schema.Struct({
  to: Schema.String,
  note: Schema.optionalKey(Schema.String),
});

export const output = Schema.Struct({
  id: Schema.String,
  sentTo: Schema.String,
});

export const METADATA = {
  label: "Send",
  description: "Sends a thing",
  category: "Demo",
};

export const CONTEXT = {
  executionId: "exec_1",
  nodeId: "n1",
  nodeName: "Send",
  nodeType: "action",
  runMode: "live",
};
