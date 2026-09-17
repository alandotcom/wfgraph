/**
 * Where each member of a focused Group sits across the flow. A member stands in
 * the column of the steps that feed it, so a step with one source sits under
 * that source. Edges that skip rows find their own lanes around the cards when
 * the canvas routes them. Every value is a member's offset across the flow from
 * the collapsed Group card, in canvas pixels.
 */

import { sortBy } from "es-toolkit/array";
import { mean } from "es-toolkit/math";

/** A member's row, listed in the topological order the rows were ranked in. */
export type GroupRowSlot = { id: string; row: number };

/**
 * `desired` spread so neighbours stand at least `pitch` apart, keeping their
 * order and each run of crowded members centred on what that run desired.
 * `desired` is sorted ascending.
 */
export function spreadInOrder(
  desired: readonly number[],
  pitch: number
): number[] {
  const runs: number[][] = [];
  const startOf = (run: readonly number[]) =>
    mean(run.map((value, index) => value - index * pitch));
  for (const value of desired) {
    runs.push([value]);
    while (runs.length > 1) {
      const last = runs.at(-1) ?? [];
      const previous = runs.at(-2) ?? [];
      if (startOf(previous) + previous.length * pitch <= startOf(last)) {
        break;
      }
      runs.splice(-2, 2, [...previous, ...last]);
    }
  }
  return runs.flatMap((run) => {
    const start = startOf(run);
    return run.map((_, index) => start + index * pitch);
  });
}

/**
 * Each member's across offset. The first row is centred on the collapsed card.
 * A later member stands at the mean of its predecessors, so a member with one
 * predecessor stands in that predecessor's column and a join stands near the
 * middle of the members that feed it. Members of one row that would crowd each
 * other spread apart by `pitch`, keeping their order. `edges` are interior
 * edges; one that does not run to a later row is ignored.
 */
export function groupAcrossOffsets(input: {
  slots: readonly GroupRowSlot[];
  edges: readonly { source: string; target: string }[];
  pitch: number;
}): Map<string, number> {
  const { slots, pitch } = input;
  // Maps, because member ids are chosen by the builder.
  const rowOf = new Map(slots.map((slot) => [slot.id, slot.row]));
  const orderOf = new Map(slots.map((slot, index) => [slot.id, index]));
  const lastRow = Math.max(0, ...slots.map((slot) => slot.row));
  const forward = input.edges.filter(
    (edge) => (rowOf.get(edge.source) ?? 0) < (rowOf.get(edge.target) ?? -1)
  );
  const predecessorsOf = Map.groupBy(forward, (edge) => edge.target);
  const slotsByRow = Map.groupBy(slots, (slot) => slot.row);

  const across = new Map<string, number>();
  for (let row = 0; row <= lastRow; row += 1) {
    const rowSlots = slotsByRow.get(row) ?? [];
    const unsorted = rowSlots.map((slot, column) => {
      const placed = (predecessorsOf.get(slot.id) ?? []).flatMap((edge) => {
        const value = across.get(edge.source);
        return value === undefined ? [] : [value];
      });
      return {
        id: slot.id,
        order: orderOf.get(slot.id) ?? 0,
        desired:
          placed.length > 0
            ? mean(placed)
            : (column - (rowSlots.length - 1) / 2) * pitch,
      };
    });
    const wanted = sortBy(unsorted, ["desired", "order"]);
    const values = spreadInOrder(
      wanted.map((item) => item.desired),
      pitch
    );
    wanted.forEach((item, index) => {
      across.set(item.id, values[index] ?? 0);
    });
  }
  return across;
}
