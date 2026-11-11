/**
 * The bag a handler is handed, and the sentences the run log shows where a
 * boundary refuses.
 *
 * `defineAction` and `defineStep` stay two functions, because an Internal
 * Extension and an External one are two concepts. Everything between the
 * engine's input record and the handler is `buildStep`, which reads its bag and
 * its wording from here.
 *
 * `subject` is the phrase each sentence names the offender by, `Step
 * "twilio/send-sms"` or `Action "appointments/cancel"`, the same phrase
 * `buildStep` and `encodeThroughOutputSchema` take.
 */

import type { StepContext } from "#src/backend/extensions/steps/step-handler";
import { getErrorMessage } from "@wfgraph/shared/utils";
import type { StepResult } from "@wfgraph/shared/actions/step-result";

/**
 * The one argument every handler is called with: its config, and the run it is
 * part of.
 *
 * One object holds every value, so a later value is one more key and nothing
 * an author wrote moves.
 * `buildStep` adds the credential reads and `step` to this, and what it builds
 * is what a handler written either way receives.
 */
export type HandlerBag<TInput> = {
  /** The node's resolved config, decoded through the schema the author declared. */
  readonly input: TInput;
  /**
   * `"test"` for a Draft run, and for a run of a published version whose
   * workflow is in Test mode; `"live"` otherwise. Every run calls the handler,
   * so a handler that must not reach a real system during a test run checks
   * this.
   */
  readonly runMode: "live" | "test";
  readonly executionId: string;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly nodeType: string;
  /** The integration the node was configured with, if any. */
  readonly integrationId?: string | undefined;
  /**
   * A key for this node of this run, the same on every pass and every retry,
   * to hand a vendor that deduplicates requests by key. `step.run` hands each
   * named step a key of its own.
   */
  readonly idempotencyKey: string;
};

/**
 * The idempotency key of a node of a run, or of one named step within it.
 *
 * Built from the run's id and the node's id alone, so it holds across passes,
 * retries and a Migration, and differs between two nodes running the same
 * action. A step name is at most 64 characters, which keeps the key within the
 * 255 characters vendors commonly accept.
 */
export function idempotencyKeyFor(
  context: Pick<StepContext, "executionId" | "nodeId">,
  stepName?: string
): string {
  const nodeKey = `${context.executionId}:${context.nodeId}`;
  return stepName === undefined ? nodeKey : `${nodeKey}:${stepName}`;
}

/**
 * The bag a handler reads, out of the decoded config and the context the engine
 * sent.
 *
 * `runMode` is the only field carrying a default: the engine may leave it empty,
 * and a handler deciding whether to touch a real external system has to be told
 * something.
 */
export function toHandlerBag<TInput>(
  input: TInput,
  context: StepContext,
  integrationId: string | undefined
): HandlerBag<TInput> {
  return {
    input,
    runMode: context.runMode ?? "live",
    executionId: context.executionId,
    nodeId: context.nodeId,
    nodeName: context.nodeName,
    nodeType: context.nodeType,
    integrationId,
    idempotencyKey: idempotencyKeyFor(context),
  };
}

/**
 * What an input record carrying no run context becomes.
 *
 * Every node the engine runs carries its context, so this is a Workflow Graph bug rather
 * than something an author wrote. Both boundaries fail the node on it, because
 * the alternative is handing an author the node ids they were promised as
 * undefined, and a run log naming a node that does not exist.
 */
export function missingContextMessage(subject: string): string {
  return `${subject} was called without a step context, so the node it belongs to cannot be identified.`;
}

/**
 * What a config the input schema refused becomes.
 *
 * The config a boundary receives is data: it came out of a jsonb column and
 * through template resolution, and neither of those is checked.
 */
export function invalidConfigMessage(subject: string, failure: string): string {
  return `${subject} received an invalid configuration: ${failure}`;
}

/**
 * What a handler's throw becomes on the node's run-log row.
 *
 * The shared reader is used because a throw is often a seam failure whose own
 * `.message` is empty -- every `Schema.TaggedError` in the backend is one --
 * and a row closed with that alone is a red node with no sentence beside it. The
 * fallback names the node so that the row still says which one gave up.
 */
export function handlerErrorMessage(subject: string, error: unknown): string {
  const message = getErrorMessage(error);
  return message === "Unknown error" ? `${subject} failed.` : message;
}

/** The envelope the engine reads for a node that did not do its work. */
export function failedStep(message: string): StepResult {
  return { success: false, error: { message } };
}
