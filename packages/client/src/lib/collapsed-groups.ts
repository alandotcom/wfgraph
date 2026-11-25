/**
 * The Groups this viewer has collapsed to a single card on the canvas, by
 * frame id. It is per viewer and per session: collapsing changes what one
 * person sees and nothing stored, so another viewer, a run and Publish read
 * the same graph either way. Folding a Group in the outline leaves it alone.
 */

import { atom } from "jotai";

export const collapsedGroupIdsAtom = atom<ReadonlySet<string>>(
  new Set<string>()
);

/** Collapse the Group `groupId` to one card, or draw it in place again. */
export const toggleGroupCollapsedAtom = atom(
  null,
  (get, set, groupId: string) => {
    const next = new Set(get(collapsedGroupIdsAtom));
    if (!next.delete(groupId)) {
      next.add(groupId);
    }
    set(collapsedGroupIdsAtom, next);
  }
);

/**
 * Draw the Group `groupId` in place, so a step inside it can be shown. Keeps
 * the set itself when the Group is not collapsed.
 */
export const expandGroupAtom = atom(null, (get, set, groupId: string) => {
  const current = get(collapsedGroupIdsAtom);
  if (!current.has(groupId)) {
    return;
  }
  const next = new Set(current);
  next.delete(groupId);
  set(collapsedGroupIdsAtom, next);
});
