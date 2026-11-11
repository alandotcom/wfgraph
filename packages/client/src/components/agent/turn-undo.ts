/**
 * Undo for one agent turn, from the panel.
 *
 * A turn's first edit pushes one entry on the editor's undo history and its
 * later edits push none, so the editor's Undo already reverts a whole turn.
 * This module remembers which history entry each turn pushed, keyed by the
 * `undoKey` on the turn's metadata, and offers that Undo only while the entry
 * is still the top of the history: any edit made since, by hand or by a later
 * turn, pushes an entry of its own and withdraws the offer.
 *
 * The entries live in memory. A turn restored from storage after a reload has
 * no entry here, and the editor's history starts empty on load anyway.
 */

import { atom, type Atom, type ExtractAtomValue } from "jotai";
import { draftEditable, historyAtom } from "#src/lib/workflow-graph-cells";
import { undoAtom } from "#src/lib/workflow-graph-store";

type HistoryEntry = ExtractAtomValue<typeof historyAtom>[number];

type UndoPoint = { entry: HistoryEntry; undone: boolean };

/** As many turns as the editor keeps undo history for. */
const MAX_UNDO_POINTS = 50;

const undoPointsAtom = atom<ReadonlyMap<string, UndoPoint>>(new Map());

/**
 * Remembers the history entry a turn's first edit pushed. Call it straight
 * after that edit is applied, while the entry is still the top of the history.
 */
export const recordAgentTurnUndoPointAtom = atom(
  null,
  (get, set, undoKey: string) => {
    const entry = get(historyAtom).at(-1);
    if (!entry) {
      return;
    }
    const points = [
      ...get(undoPointsAtom),
      [undoKey, { entry, undone: false }] as const,
    ];
    set(undoPointsAtom, new Map(points.slice(-MAX_UNDO_POINTS)));
  }
);

/**
 * - `available`: the turn's edits are the latest on the canvas and can be undone.
 * - `undone`: the panel's Undo already reverted them.
 * - `superseded`: other edits were made since, so Undo would revert those.
 * - `unknown`: the turn ran before this page loaded.
 */
export type AgentTurnUndoState =
  | "available"
  | "undone"
  | "superseded"
  | "unknown";

/** Where one turn's undo stands. A new atom per call; memoize it in render. */
export function agentTurnUndoStateAtom(
  undoKey: string
): Atom<AgentTurnUndoState> {
  return atom((get) => {
    const point = get(undoPointsAtom).get(undoKey);
    if (!point) {
      return "unknown";
    }
    if (point.undone) {
      return "undone";
    }
    return get(historyAtom).at(-1) === point.entry && draftEditable(get)
      ? "available"
      : "superseded";
  });
}

/** Performs the editor's Undo for the turn, when it is still available. */
export const undoAgentTurnAtom = atom(null, (get, set, undoKey: string) => {
  const point = get(undoPointsAtom).get(undoKey);
  if (
    !point ||
    point.undone ||
    get(historyAtom).at(-1) !== point.entry ||
    !draftEditable(get)
  ) {
    return;
  }
  set(undoAtom);
  set(
    undoPointsAtom,
    new Map(get(undoPointsAtom)).set(undoKey, { ...point, undone: true })
  );
});
