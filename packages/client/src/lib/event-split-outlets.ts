/**
 * An Event Split node's outlets, derived rather than configured.
 *
 * One outlet per Event that can reach the node, so a builder never has to keep a
 * list in step with the Lifecycle Rules and no Event goes unlisted. The canvas
 * draws a handle per member and the config panel names them; both ask here, so
 * the handle an edge binds to and the Event the panel shows cannot disagree.
 */

import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { getExtensionCatalog } from "#src/lib/extensions";
import { eventsReachingTarget } from "#src/lib/upstream-node-fields";
import { edgesAtom, nodesAtom } from "#src/lib/workflow-graph-store";
import type { EventMetadata } from "@wfgraph/shared/extensions/catalog";

const NO_OUTLETS: EventMetadata[] = [];

/**
 * A null id answers nothing, which is what every node that is not a split passes:
 * both atoms change identity on any edit, so a canvas of N nodes would walk the
 * graph N times to serve the one that asks.
 */
export function useEventSplitOutlets(nodeId: string | null): EventMetadata[] {
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);

  return useMemo(
    () =>
      nodeId
        ? eventsReachingTarget({
            targetNodeId: nodeId,
            nodes,
            edges,
            catalog: getExtensionCatalog(),
          })
        : NO_OUTLETS,
    [nodeId, nodes, edges]
  );
}
