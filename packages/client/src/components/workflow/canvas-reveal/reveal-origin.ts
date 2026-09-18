/**
 * Back from a node a jump reached, to the node the jump started from. The jump
 * records the origin node; Back selects it again, and the camera treats that
 * as any other change of subject.
 */

import { nodesAtom, selectOnlyNodeAtom } from "#src/lib/workflow-graph-store";
import { activeRevealPresentationAtom } from "#src/lib/workflow-workspace-navigation";
import type { RevealKind } from "./reveal-kinds";

/**
 * Back or Escape for a node a jump can reach. While the active scope still
 * inspects `subject`'s node with a recorded origin that the graph holds, this
 * selects the origin again. Otherwise it runs `unwindLevel`.
 */
export const unwindToInspectedOrigin: NonNullable<RevealKind["unwind"]> = ({
  subject,
  store,
  unwindLevel,
}) => {
  const presentation = store.get(activeRevealPresentationAtom);
  const origin =
    presentation.inspected?.kind === "node" &&
    presentation.inspected.id === subject.nodeId
      ? presentation.inspectedOrigin
      : null;
  if (
    origin === null ||
    !store.get(nodesAtom).some((node) => node.id === origin.nodeId)
  ) {
    unwindLevel();
    return;
  }
  store.set(selectOnlyNodeAtom, origin.nodeId);
};
