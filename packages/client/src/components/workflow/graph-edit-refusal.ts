/**
 * The notice a refused canvas edit shows. A connection, an added step, a paste
 * and a duplicate each answer a refusal sentence when the Group rules or the
 * connection rules refuse them, and every such sentence shows in the one
 * notice slot, so a second refusal replaces the first.
 */

import { toast } from "sonner";

/** The notice id every refused canvas edit shares. */
export const GRAPH_EDIT_REFUSED_TOAST_ID = "connection-refused";

/** Show `outcome`'s refusal, when it is one. Anything else shows nothing. */
export function showGraphEditRefusal(
  outcome: { refusal: string } | object | null
): void {
  if (outcome !== null && "refusal" in outcome) {
    toast.info(outcome.refusal, { id: GRAPH_EDIT_REFUSED_TOAST_ID });
  }
}
