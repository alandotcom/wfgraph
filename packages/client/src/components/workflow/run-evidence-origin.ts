/**
 * What opened the run node evidence on screen. Back and Escape on Runs read it
 * to return focus to that element. A canvas node press, a row of the run's
 * outline and the failure summary's step link write it.
 */

import { atom } from "jotai";

/**
 * What opened a run node's evidence in one address: one execution, named by
 * its log id, or the node itself, with a null `logId`. `fromOutline` marks a
 * press on the node's row in the run's outline rather than on its card.
 */
type RunEvidenceOrigin = {
  addressId: string;
  nodeId: string;
  logId: string | null;
  fromOutline?: boolean | undefined;
};

/** The element that last opened run node evidence, or null. */
export const runEvidenceOriginAtom = atom<RunEvidenceOrigin | null>(null);
