/** Test assertions over the overview cards `node-placement` keeps apart. */

import {
  overviewCardRectangle,
  rectanglesOverlap,
  type PlacedNode,
} from "#src/graph/node-placement";

/**
 * Each pair of ids of top-level nodes in `nodes` whose overview cards overlap,
 * with a Group at its collapsed card size. Empty when every card is clear.
 */
export function overlappingCardIds(nodes: readonly PlacedNode[]): string[][] {
  const cards = nodes.filter(
    (node) => node.type !== "add" && node.parentId === undefined
  );
  return cards.flatMap((card, index) =>
    cards
      .slice(index + 1)
      .filter((other) =>
        rectanglesOverlap(
          overviewCardRectangle(card),
          overviewCardRectangle(other)
        )
      )
      .map((other) => [card.id, other.id])
  );
}
