/**
 * What is wrong with the graph: the pass that keeps `workflowIssuesAtom` in step
 * with the canvas, and the two hooks that open the list of what it found.
 *
 * The collector is mounted once, by the canvas. It needs three things the store
 * cannot reach on its own -- the graph, the extension catalog (React context)
 * and the operator's connection list (query cache) -- so this module is where
 * they meet, and opening the list needs the same three.
 *
 * The graph is debounced because a drag rewrites the node array every frame and
 * a position cannot change a verdict. Everything else is derived in render.
 */

import { useQuery } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import { useAtomCallback } from "jotai/utils";
import { useCallback, useMemo, useState } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { WorkflowIssuesOverlay } from "#src/components/overlays/workflow-issues-overlay";
import {
  useAfterPaint,
  useDebouncedValue,
  useAfterCommit,
} from "#src/hooks/effects";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import { nodesAtom, selectedNodeAtom } from "#src/lib/workflow-graph-store";
import { toPersistedNodes } from "#src/lib/workflow-graph-types";
import {
  NO_ISSUES,
  providerFieldIssuesAtom,
  sameIssues,
  workflowIssuesAtom,
} from "#src/lib/workflow-issues-store";
import { useProviderFieldIssues } from "#src/hooks/use-provider-field-issues";
import { enterDraftWorkspaceAtom } from "#src/lib/workflow-workspace-navigation";
import {
  collectWorkflowIssues,
  groupWorkflowIssuesForOverlay,
} from "@wfgraph/shared/graph/workflow-issues";

/** How long the canvas must sit still before it is validated again. */
const SETTLE_MS = 300;

export function useCollectWorkflowIssues(): void {
  const nodes = useAtomValue(nodesAtom);
  const catalog = useExtensionCatalog();
  const { data: integrations } = useQuery(integrationsQueryOptions());
  const setIssues = useSetAtom(workflowIssuesAtom);

  const settledNodes = useDebouncedValue(nodes, SETTLE_MS);
  const persisted = useMemo(
    () => toPersistedNodes(settledNodes),
    [settledNodes]
  );
  // What the operator's own connections say a provider-backed field still needs.
  // The shared collector cannot ask, so these are raised here and merged into
  // the one list the badge, the count and the publish gate all read.
  const providerIssues = useProviderFieldIssues(persisted, catalog);
  const setProviderIssues = useSetAtom(providerFieldIssuesAtom);

  const issues = useMemo(() => {
    // `undefined` is "the connection list has not arrived", which is a
    // different answer from "this operator has no connections". Defaulting it
    // to `[]` accused every node that named a connection, and -- because the
    // literal was new each render -- wrote the atom, re-rendered the canvas,
    // and arrived back here without bound.
    if (!integrations) {
      return NO_ISSUES;
    }

    return [
      ...collectWorkflowIssues({ nodes: persisted, catalog, integrations }),
      ...providerIssues,
    ];
  }, [persisted, catalog, integrations, providerIssues]);

  // Held for `useShowWorkflowIssues`, which recollects on the click rather than
  // reading the settled list, and would otherwise show fewer issues than the
  // badge it was opened from.
  useAfterCommit(providerIssues, () => {
    setProviderIssues((previous) =>
      sameIssues(previous, providerIssues) ? previous : providerIssues
    );
  });

  // Keeping the previous list when the verdict has not changed is what stops
  // this from undoing #116: every settle recollects, and a content-identical
  // answer written as a fresh array would rebuild each summary, miss the paint
  // cache in `displayNodesAtom`, and repaint every flagged card for nothing.
  useAfterCommit(issues, () => {
    setIssues((previous) => (sameIssues(previous, issues) ? previous : issues));
  });
}

/**
 * Open a step, and optionally put the cursor in the field an issue named.
 *
 * The panel holding that field mounts in the commit this triggers, which is why
 * the focus waits for the next paint rather than for a timeout: the version this
 * replaced raced the panel and won only because the panel is fast.
 */
export function useGoToStep(): (nodeId: string, fieldKey?: string) => void {
  const setSelectedNodeId = useSetAtom(selectedNodeAtom);
  const enterDraft = useSetAtom(enterDraftWorkspaceAtom);
  const [pendingFieldFocus, setPendingFieldFocus] = useState<string | null>(
    null
  );

  useAfterPaint(pendingFieldFocus, () => {
    if (!pendingFieldFocus) {
      return;
    }
    setPendingFieldFocus(null);
    const element = document.getElementById(pendingFieldFocus);
    if (!element) {
      return;
    }
    element.focus();
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  return useCallback(
    (nodeId: string, fieldKey?: string) => {
      setSelectedNodeId(nodeId);
      enterDraft();
      setPendingFieldFocus(fieldKey ?? null);
    },
    [enterDraft, setSelectedNodeId]
  );
}

/**
 * Open the issues list on its own, for a reader who asked rather than for a run
 * that was refused. It offers no "Run anyway" for that reason.
 *
 * The graph is re-collected on the click rather than read off
 * `workflowIssuesAtom`, because that atom trails the canvas by the collector's
 * settle window and this list is what a builder then works down.
 *
 * It reads the graph through `useAtomCallback` rather than subscribing to
 * `nodesAtom`, which is what the caller needs it to do: `onNodesChange` rewrites
 * that array on every frame of a drag, and the status strip's issue count would
 * otherwise re-render at 60fps to display a number that had not moved.
 */
export function useShowWorkflowIssues(): () => void {
  const catalog = useExtensionCatalog();
  const { data: integrations = [] } = useQuery(integrationsQueryOptions());
  const { open: openOverlay } = useOverlay();
  const goToStep = useGoToStep();
  const readNodes = useAtomCallback(useCallback((get) => get(nodesAtom), []));
  const providerIssues = useAtomValue(providerFieldIssuesAtom);

  return useCallback(() => {
    const issues = [
      ...collectWorkflowIssues({
        nodes: toPersistedNodes(readNodes()),
        catalog,
        integrations,
      }),
      ...providerIssues,
    ];

    openOverlay(WorkflowIssuesOverlay, {
      issues: groupWorkflowIssuesForOverlay(issues),
      onGoToStep: goToStep,
      allowRunAnyway: false,
    });
  }, [readNodes, catalog, integrations, providerIssues, openOverlay, goToStep]);
}
