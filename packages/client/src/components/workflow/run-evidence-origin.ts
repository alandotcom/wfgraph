/**
 * What opened the run node evidence on screen. Back and Escape on Runs read it
 * to return focus to that element, or to close a Reveal the opening opened.
 * A canvas node press and a journey entry both write it.
 */

import { atom } from "jotai";
import type { OpenRevealLevel } from "#src/lib/workflow-navigation-state";

/**
 * What opened a run node's evidence in one address: a journey entry, named by
 * its log id, or the canvas node itself, with a null `logId`.
 * `closedReopenLevel` is set when a canvas click opened Focus straight from a
 * closed Canvas Reveal, and holds the level Reveal reopened at before it.
 */
type RunEvidenceOrigin = {
  addressId: string;
  nodeId: string;
  logId: string | null;
  closedReopenLevel: OpenRevealLevel | null;
};

/** The element that last opened run node evidence, or null. */
export const runEvidenceOriginAtom = atom<RunEvidenceOrigin | null>(null);
