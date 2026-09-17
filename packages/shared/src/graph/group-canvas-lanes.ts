/**
 * Where each member of a focused Group sits across the flow. An edge turns in
 * the gap just before its target's row, so an edge that skips rows runs straight
 * along its source's lane through them, and no member in those rows covers the
 * lane. Every value is a member's offset across the flow from the collapsed
 * Group card, in canvas pixels.
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
function spreadInOrder(desired: readonly number[], pitch: number): number[] {
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
 * `positions` moved so no two stand closer than `pitch` and no card stands
 * closer than half a pitch to a lane. A card that covers a lane moves to the
 * lane's nearer side, and moves right when the left side would crowd its left
 * neighbour or another lane. `positions` is sorted ascending.
 */
function clearOfLanes(
  positions: readonly number[],
  lanes: readonly number[],
  pitch: number
): number[] {
  const gap = pitch / 2;
  const sortedLanes = lanes.toSorted((a, b) => a - b);
  const clear = (value: number) =>
    sortedLanes.every((lane) => Math.abs(value - lane) >= gap);
  const placed: number[] = [];
  for (const position of positions) {
    const floor = (placed.at(-1) ?? Number.NEGATIVE_INFINITY) + pitch;
    let value = Math.max(position, floor);
    for (const lane of sortedLanes) {
      if (Math.abs(value - lane) >= gap) {
        continue;
      }
      const left = lane - gap;
      const right = lane + gap;
      value =
        left >= floor &&
        clear(left) &&
        Math.abs(left - position) < Math.abs(right - position)
          ? left
          : right;
    }
    placed.push(value);
  }
  return placed;
}

/**
 * Each member's across offset. The first row is centred on the collapsed card.
 * A later member stands at the mean of its predecessors, spread from its
 * row neighbours by `pitch`, and kept clear of the lane of every edge that skips
 * its row. `trailingStubSourceIds` are members with an edge to a stub after the
 * last row, either continuing outside the Group or ending a path, and each keeps
 * a lane through every row below it to those stubs.
 * `edges` are interior edges; one that does not run to a later row is ignored.
 * An "Incoming from" stub edge into a member below the first row keeps no lane,
 * because that member then joins a branch from outside the Group, which breaks
 * `join_crosses_boundary`.
 */
export function groupAcrossOffsets(input: {
  slots: readonly GroupRowSlot[];
  edges: readonly { source: string; target: string }[];
  trailingStubSourceIds: ReadonlySet<string>;
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
  const outgoingFrom = Map.groupBy(forward, (edge) => edge.source);
  const slotsByRow = Map.groupBy(slots, (slot) => slot.row);

  const across = new Map<string, number>();
  const lanesByRow = new Map<number, number[]>();
  const addLanes = (value: number, fromRow: number, toRow: number) => {
    for (let row = fromRow; row < toRow; row += 1) {
      lanesByRow.set(row, [...(lanesByRow.get(row) ?? []), value]);
    }
  };

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
    const values = clearOfLanes(
      spreadInOrder(
        wanted.map((item) => item.desired),
        pitch
      ),
      lanesByRow.get(row) ?? [],
      pitch
    );

    wanted.forEach((item, index) => {
      const value = values[index] ?? 0;
      across.set(item.id, value);
      const targetRows = (outgoingFrom.get(item.id) ?? []).map(
        (edge) => rowOf.get(edge.target) ?? row
      );
      addLanes(value, row + 1, Math.max(row + 1, ...targetRows));
      if (input.trailingStubSourceIds.has(item.id)) {
        addLanes(value, row + 1, lastRow + 1);
      }
    });
  }
  return across;
}
