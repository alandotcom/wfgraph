/**
 * What both backends share about the database executor's fenced writes: the
 * one list of writes the engine's store reaches, the refusals a fenced write
 * answers, and the guard that holds each fenced write to the run its fence
 * names. Each backend writes the statements and takes its own locks.
 */

import { Effect } from "effect";
import {
  type DatabaseError,
  LeaseLost,
} from "#src/backend/lib/effect/database";
import type { AuditRepoMethods } from "#src/backend/services/executions/repo/audit";
import type { OwnerFence } from "#src/backend/services/executions/repo/contracts";
import type { NodeLogsRepoMethods } from "#src/backend/services/executions/repo/node-logs";
import type { RunsRepoMethods } from "#src/backend/services/executions/repo/runs";
import type { PassWrites } from "#src/backend/services/executions/repo/schedule";
import type { WaitsRepoMethods } from "#src/backend/services/executions/repo/waits";

/**
 * The refusal a fenced write answers when the pass's schedule row no longer
 * names the pass: its lease expired and another claim took the run, a policy
 * cancel or a terminal write deleted the row, or the row was released.
 */
export function ownershipLost(): LeaseLost {
  return new LeaseLost({
    message: "The pass no longer holds this run's lease",
  });
}

/** The refusal a fenced write answers when it addresses a run its fence does not name. */
function addressesAnotherRun(): LeaseLost {
  return new LeaseLost({
    message: "The write addresses a run this pass does not hold",
  });
}

/**
 * The repository writes the engine's `WorkflowStore` reaches. Each backend's
 * `ExecutionRepo.fenced`, the executor's watched writes and the test stub are
 * built from this list.
 */
export const STORE_WRITE_NAMES = [
  "openNodeLog",
  "closeNodeLog",
  "cancelOpenNodeLogs",
  "recordAuditEvent",
  "startWait",
  "reparkWait",
  "markWaitStatus",
  "settleWaitTimeout",
  "cancelWaitsForExecution",
  "markRunning",
  "markWaitingIfParked",
  "requestExit",
  "finishRun",
] as const;
export type StoreWriteName = (typeof STORE_WRITE_NAMES)[number];

/** The writes only a pass makes, beside the store writes. */
export const PASS_WRITE_NAMES = [
  "renewLease",
  "writeStepMemo",
  "recordParkStep",
  "releasePass",
  "dropSchedule",
] as const satisfies readonly (keyof PassWrites)[];

type RepoMethods = RunsRepoMethods &
  NodeLogsRepoMethods &
  WaitsRepoMethods &
  AuditRepoMethods;

/** Each store write's input and output, read off the repository's unfenced method. */
type StoreWriteSignatures = {
  [Name in StoreWriteName]: RepoMethods[Name] extends (
    input: infer Input
  ) => Effect.Effect<infer Output, DatabaseError>
    ? { input: Input; output: Output }
    : never;
};

/**
 * The repository writes the engine's `WorkflowStore` reaches, as
 * `createDbWorkflowStore` binds them. The unfenced methods of `ExecutionRepo`
 * fill it on the Inngest path, and `ExecutionRepo.fenced` on a pass of the
 * database executor, where a write may also answer `LeaseLost`.
 */
export type StoreWrites = {
  readonly [Name in StoreWriteName]: StoreWriteOf<Name>;
};

/** One store write, which a fenced pass may also see answer `LeaseLost`. */
type StoreWriteOf<Name extends StoreWriteName> = (
  input: StoreWriteSignatures[Name]["input"]
) => Effect.Effect<
  StoreWriteSignatures[Name]["output"],
  DatabaseError | LeaseLost
>;

/** What `ExecutionRepo.fenced` answers for one pass. */
export type FencedExecutionWrites = StoreWrites & PassWrites;

type PartialStoreWrites = {
  [Name in StoreWriteName]?: StoreWriteOf<Name>;
};

function setStoreWrite<Name extends StoreWriteName>(
  writes: PartialStoreWrites,
  name: Name,
  write: StoreWriteOf<Name>
): void {
  writes[name] = write;
}

function hasEveryStoreWrite(writes: PartialStoreWrites): writes is StoreWrites {
  return STORE_WRITE_NAMES.every((name) => writes[name] !== undefined);
}

/** Builds a full set of store writes by calling `build` once per name. */
export function buildStoreWrites(
  build: <Name extends StoreWriteName>(name: Name) => StoreWriteOf<Name>
): StoreWrites {
  const writes: PartialStoreWrites = {};
  for (const name of STORE_WRITE_NAMES) {
    setStoreWrite(writes, name, build(name));
  }
  if (!hasEveryStoreWrite(writes)) {
    throw new Error("A store write was left unbuilt");
  }
  return writes;
}

/**
 * The run each store write addresses, read off its input. A write addressed
 * by a log or wait row id answers undefined: its statement narrows the row to
 * the fence's run itself. So does a workflow-scoped audit entry, which names
 * no run.
 */
const addressedRun: {
  [Name in StoreWriteName]: (
    input: StoreWriteSignatures[Name]["input"]
  ) => string | undefined;
} = {
  openNodeLog: (input) => input.executionId,
  closeNodeLog: () => undefined,
  cancelOpenNodeLogs: (executionId) => executionId,
  recordAuditEvent: (input) => input.executionId,
  startWait: (input) => input.executionId,
  reparkWait: () => undefined,
  markWaitStatus: () => undefined,
  settleWaitTimeout: () => undefined,
  cancelWaitsForExecution: (executionId) => executionId,
  markRunning: (input) => input.executionId,
  markWaitingIfParked: (input) => input.executionId,
  requestExit: (input) => input.executionId,
  finishRun: (input) => input.executionId,
};

/**
 * Holds a backend's fenced store writes to the run `fence` names: a write
 * whose input addresses another run is refused with `LeaseLost` before it
 * reaches the database.
 */
export function guardStoreWrites(
  fence: OwnerFence,
  writes: StoreWrites
): StoreWrites {
  return buildStoreWrites((name) => (input) => {
    const run = addressedRun[name](input);
    return run === undefined || run === fence.executionId
      ? writes[name](input)
      : Effect.fail(addressesAnotherRun());
  });
}
