/**
 * Keeps `workflowIssuesAtom` in step with the canvas.
 *
 * Mounted once, by the canvas. The collector needs three things the store cannot
 * reach on its own -- the graph, the extension catalog (React context) and the
 * operator's connection list (query cache) -- so this hook is where they meet.
 *
 * The graph is debounced because a drag rewrites the node array every frame and
 * a position cannot change a verdict. Everything else is derived in render.
 */

import { useQuery } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import { useMemo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { useDebouncedValue, useAfterCommit } from "#src/hooks/effects";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import { nodesAtom } from "#src/lib/workflow-graph-store";
import { toPersistedNodes } from "#src/lib/workflow-graph-types";
import { sameIssues, workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import {
  collectWorkflowIssues,
  type WorkflowIssue,
} from "@wfgraph/shared/graph/workflow-issues";

/** How long the canvas must sit still before it is validated again. */
const SETTLE_MS = 300;

/** One array for "nothing to say", so an idle pass allocates nothing. */
const NO_ISSUES: WorkflowIssue[] = [];

export function useCollectWorkflowIssues(): void {
  const nodes = useAtomValue(nodesAtom);
  const catalog = useExtensionCatalog();
  const { data: integrations } = useQuery(integrationsQueryOptions());
  const setIssues = useSetAtom(workflowIssuesAtom);

  const settledNodes = useDebouncedValue(nodes, SETTLE_MS);

  const issues = useMemo(() => {
    // `undefined` is "the connection list has not arrived", which is a
    // different answer from "this operator has no connections". Defaulting it
    // to `[]` accused every node that named a connection, and -- because the
    // literal was new each render -- wrote the atom, re-rendered the canvas,
    // and arrived back here without bound.
    if (!integrations) {
      return NO_ISSUES;
    }

    return collectWorkflowIssues({
      nodes: toPersistedNodes(settledNodes),
      catalog,
      integrations,
    });
  }, [settledNodes, catalog, integrations]);

  // Keeping the previous list when the verdict has not changed is what stops
  // this from undoing #116: every settle recollects, and a content-identical
  // answer written as a fresh array would rebuild each summary, miss the paint
  // cache in `displayNodesAtom`, and repaint every flagged card for nothing.
  useAfterCommit(issues, () => {
    setIssues((previous) => (sameIssues(previous, issues) ? previous : issues));
  });
}
