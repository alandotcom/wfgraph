/**
 * What opened the run node evidence on screen. Back and Escape on Runs read it
 * to return focus to that element. A canvas node press and a journey entry
 * both write it.
 */

import { atom } from "jotai";

/**
 * What opened a run node's evidence in one address: a journey entry, named by
 * its log id, or the canvas node itself, with a null `logId`.
 */
type RunEvidenceOrigin = {
  addressId: string;
  nodeId: string;
  logId: string | null;
};

/** The element that last opened run node evidence, or null. */
export const runEvidenceOriginAtom = atom<RunEvidenceOrigin | null>(null);
