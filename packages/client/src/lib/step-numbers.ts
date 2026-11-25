/**
 * Each step's number in run order, keyed by node id. A step's outline row and
 * its canvas card show the same number, and the outline's model is what
 * numbers the steps. A node the map does not hold, such as the Lifecycle Node,
 * draws no number.
 */

import { atom, useAtomValue } from "jotai";

export const stepNumbersAtom = atom<ReadonlyMap<string, number>>(new Map());

/** The step number of node `id`, or undefined when it has none. */
export function useStepNumber(id: string): number | undefined {
  return useAtomValue(stepNumbersAtom).get(id);
}
