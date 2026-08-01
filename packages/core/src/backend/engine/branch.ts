/**
 * What a branch run hands back to the run that started it.
 *
 * A waiting branch is its own durable run (ADR-0011), so the run that handed it
 * off learns everything that happened behind the Wait from this one value. It
 * crosses `step.invoke` as JSON, and the schema below is that boundary's decode:
 * this value becomes the run's own results, so a shape nobody checked would
 * reach the terminal record as a verdict.
 */

import { Schema } from "effect";
import type {
  ExecutionResult,
  NodeOutputs,
} from "#src/backend/engine/contracts";

/** What a branch run's traversal left behind, keyed the way its own was. */
export type BranchRunResult = {
  results: Record<string, ExecutionResult>;
  outputs: NodeOutputs;
};

/**
 * How a branch run ended.
 *
 * `killed` is a cancellation: the branch was stopped where it stood, so its own
 * run-log rows and wait states are still open, and the run reading this closes
 * them before it enters the Canceled outlet.
 */
export type BranchHandoff =
  | { status: "finished"; result: BranchRunResult }
  | { status: "killed" };

/**
 * `ExecutionResult` as it reads back off the wire.
 *
 * `optionalKey` rather than `optional`, because this is decoded from a value
 * that has been through `JSON.parse`, where a key is present or absent and
 * never `undefined`.
 */
const executionResultSchema = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.Struct({ message: Schema.String }),
  }),
  Schema.Struct({
    success: Schema.Literal(true),
    data: Schema.optionalKey(Schema.MutableJson),
    haltBranch: Schema.optionalKey(Schema.Boolean),
  }),
]);

export const branchRunResultSchema = Schema.Struct({
  results: Schema.Record(Schema.String, executionResultSchema),
  outputs: Schema.Record(
    Schema.String,
    Schema.Struct({ label: Schema.String, data: Schema.MutableJson })
  ),
}) satisfies Schema.Codec<BranchRunResult>;
