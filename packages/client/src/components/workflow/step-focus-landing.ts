import { outlineRowElementId } from "#src/components/workflow/outline/workflow-outline";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

/**
 * Where keyboard focus goes when the element holding it leaves the page, such
 * as a card an undo removed. Each helper acts only when focus has already
 * fallen to the page body, so a person who moved focus elsewhere keeps it.
 */

/**
 * The step a removed step followed: walks back along incoming connections
 * of `before` until it reaches a step `after` still holds. Null when the
 * removed step had nothing before it that survived.
 */
export function stepBeforeRemoved(input: {
  removedId: string;
  before: { edges: readonly WorkflowEdge[] };
  after: { nodes: readonly WorkflowNode[] };
}): string | null {
  const surviving = new Set(input.after.nodes.map((node) => node.id));
  const visited = new Set<string>();
  let current = input.removedId;
  while (!visited.has(current)) {
    visited.add(current);
    const source = input.before.edges.find(
      (edge) => edge.target === current
    )?.source;
    if (source === undefined) {
      return null;
    }
    if (surviving.has(source)) {
      return source;
    }
    current = source;
  }
  return null;
}

/**
 * After two frames, when focus sits on the page body, focuses the outline
 * row of `nodeId`, or its card on the canvas when the outline is not shown.
 * Two frames, because React Flow blurs a deselected card one frame after the
 * change that deselected it.
 */
export function focusStepWhenFocusIsLost(
  nodeId: string,
  card?: Element | null
): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active !== null && active !== document.body) {
        return;
      }
      const row = document.getElementById(outlineRowElementId(nodeId));
      const ownCard =
        card instanceof HTMLElement && card.isConnected
          ? card
          : document.querySelector<HTMLElement>(
              `.react-flow__node[data-id="${CSS.escape(nodeId)}"]`
            );
      (row ?? ownCard)?.focus({ preventScroll: true });
    });
  });
}

/**
 * Focuses the outline's current row: the one row of its tree that takes Tab,
 * which is the first row until the person moves through the outline. Does
 * nothing when the outline is not shown.
 */
export function focusOutlineCurrentRow(): void {
  document
    .querySelector<HTMLElement>(
      '[data-slot="outline-body"] [role="treeitem"][tabindex="0"]'
    )
    ?.focus({ preventScroll: true });
}
