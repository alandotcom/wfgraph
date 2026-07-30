/**
 * The name a run log gives a workflow's entry node.
 *
 * All that is left of the trigger definitions. An app declares Events now, with
 * `defineEvent`, and the Lifecycle Rules on the entry node are where a Workflow
 * Builder says which Events start a run and which cancel it (ADR-0007). What a
 * saved graph still carries is whichever `triggerType` was written when it was
 * configured, and the engine still has to name that node in a log, which is the
 * whole of this. B5 replaces the entry node's fields and takes it with it.
 */

import { asNonEmptyString } from "#src/types/string";

/**
 * A node naming no type is a run someone started by hand, and any name it does
 * carry is its own label: "Webhook" is what the webhook entry node was called, and
 * a type this build has never heard of is drawn under the name it was saved with
 * rather than refused.
 */
export function entryNodeLabel(
  config: Record<string, unknown> | undefined
): string {
  return asNonEmptyString(config?.triggerType) ?? "Trigger";
}
