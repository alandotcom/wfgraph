/**
 * Back from a node a jump reached, to the node the jump started from. The jump
 * records the origin node; Back selects it again, and the camera treats that
 * as any other change of subject.
 */

import { nodesAtom, selectOnlyNodeAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import type { DesktopScopePresentation } from "#src/lib/workflow-navigation-state";
import { activeRevealPresentationAtom } from "#src/lib/workflow-workspace-navigation";
import type { RevealKind } from "./reveal-kinds";
import type { RevealSubject } from "./reveal-subject";

/**
 * The node Back returns `subject` to: the recorded origin of the jump that
 * reached it, while the scope still inspects `subject`'s node and the graph
 * holds the origin, and otherwise null.
 */
export function inspectedOriginNodeId(input: {
  presentation: DesktopScopePresentation;
  subject: RevealSubject;
  nodes: readonly WorkflowNode[];
}): string | null {
  const { presentation, subject } = input;
  const origin =
    presentation.inspected?.kind === "node" &&
    presentation.inspected.id === subject.nodeId
      ? presentation.inspectedOrigin
      : null;
  return origin !== null &&
    input.nodes.some((node) => node.id === origin.nodeId)
    ? origin.nodeId
    : null;
}

/**
 * Back or Escape for a node a jump can reach. While a recorded origin stands,
 * this selects the origin again. Otherwise it runs `unwindLevel`.
 */
export const unwindToInspectedOrigin: NonNullable<RevealKind["unwind"]> = ({
  subject,
  store,
  unwindLevel,
}) => {
  const originId = inspectedOriginNodeId({
    presentation: store.get(activeRevealPresentationAtom),
    subject,
    nodes: store.get(nodesAtom),
  });
  if (originId === null) {
    unwindLevel();
    return;
  }
  store.set(selectOnlyNodeAtom, originId);
};
