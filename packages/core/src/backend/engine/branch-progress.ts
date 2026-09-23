/**
 * Restores completed nodes a killed branch could not return to its parent.
 *
 * The run-log rows are the persisted history for work that finished before the
 * kill. Outputs and results already present in the parent traversal remain the
 * authority for those nodes, especially the Lifecycle payload a Cancel claim
 * writes onto the entry node.
 */

import { engineFailure } from "#src/backend/engine/engine-failure";
import { wrapStoredOutput } from "#src/backend/engine/contracts";
import type { CompletedNodeProgress } from "#src/backend/engine/store";
import type { Traversal } from "#src/backend/engine/traversal";

/** Adds persisted progress only where the current traversal has no value. */
export function restoreCompletedNodeProgress(
  traversal: Traversal,
  progress: readonly CompletedNodeProgress[]
): void {
  for (const completed of progress) {
    const node = traversal.getNode(completed.nodeId);

    const storedOutput = wrapStoredOutput(completed.output);

    if (!Object.hasOwn(traversal.results, completed.nodeId)) {
      const result =
        completed.status === "success"
          ? { success: true as const, data: storedOutput }
          : {
              success: false as const,
              error: engineFailure(
                "failure",
                completed.error ??
                  `Node "${completed.nodeName}" failed without a recorded message`
              ),
            };
      traversal.markCompleted(completed.nodeId, result);
    }

    if (!Object.hasOwn(traversal.outputs, completed.nodeId)) {
      traversal.setOutput(completed.nodeId, {
        label: node?.data.label || completed.nodeName,
        // A failed node has no template payload. The traversal records that as
        // null, even when its log row holds the failure object for the Runs view.
        data: completed.status === "success" ? storedOutput : null,
      });
    }
  }
}
