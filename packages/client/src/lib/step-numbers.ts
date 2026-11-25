/**
 * Each step's number in run order, keyed by node id. A step's outline row and
 * its canvas card show the same number, and the outline's model is what
 * numbers the steps. A node the map does not hold, such as the Lifecycle Node,
 * draws no number.
 */

import { atom, useAtomValue } from "jotai";
import { atomWithDefault, selectAtom } from "jotai/utils";
import { workflowStepNumbers } from "@wfgraph/shared/graph/workflow-outline";
import { getExtensionCatalog } from "#src/lib/extensions";
import { presentedGraphAtom } from "#src/lib/workflow-graph-presentation-store";
import { edgesAtom, nodesAtom } from "#src/lib/workflow-graph-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";

const NO_NUMBERS: ReadonlyMap<string, number> = new Map();

/**
 * The graph whose steps are numbered: the open run's pinned graph in Runs, and
 * the draft everywhere else. The review sheet draws removed steps beside the
 * draft's, and those keep no number, so review numbers come from the draft too.
 */
const numberedGraphAtom = atom((get) =>
  get(workflowWorkspaceViewAtom) === "runs"
    ? get(presentedGraphAtom)
    : { nodes: get(nodesAtom), edges: get(edgesAtom) }
);

function sameNumbers(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>
): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [id, number] of a) {
    if (b.get(id) !== number) {
      return false;
    }
  }
  return true;
}

/**
 * The outline's numbers for that graph. Dragging a card replaces the graph on
 * every frame and rarely changes a number, so the map keeps its identity until
 * a number changes and the cards do not re-render while a card moves.
 */
const outlineStepNumbersAtom = selectAtom(
  numberedGraphAtom,
  (graph) =>
    graph
      ? workflowStepNumbers({
          nodes: graph.nodes,
          edges: graph.edges,
          catalog: getExtensionCatalog(),
        })
      : NO_NUMBERS,
  sameNumbers
);

export const stepNumbersAtom = atomWithDefault<ReadonlyMap<string, number>>(
  (get) => get(outlineStepNumbersAtom)
);

/** The step number of node `id`, or undefined when it has none. */
export function useStepNumber(id: string): number | undefined {
  return useAtomValue(stepNumbersAtom).get(id);
}
