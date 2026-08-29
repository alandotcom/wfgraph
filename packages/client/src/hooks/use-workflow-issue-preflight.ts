import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "jotai";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { useUnmountCleanup } from "#src/hooks/effects";
import { fetchProviderFieldIssues } from "#src/lib/provider-field-issues";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { collectAllWorkflowIssues } from "#src/lib/workflow-issues-store";
import {
  toPersistedNodes,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import type { WorkflowIssue } from "@wfgraph/shared/graph/workflow-issues";

export type WorkflowIssuePreflightResult =
  | { readonly status: "ready"; readonly issues: WorkflowIssue[] }
  | { readonly status: "busy" }
  | { readonly status: "workflow_changed" }
  | { readonly status: "unavailable" };

type ActivePreflight = {
  readonly generation: number;
  readonly workflowId: string;
  unsubscribe: () => void;
};

/** Recheck one click-time graph snapshot before Run or Publish proceeds. */
export function useWorkflowIssuePreflight(
  integrations: ReadonlyArray<{ id: string; type: string }>
): {
  checkWorkflowIssues: (input: {
    workflowId: string;
    nodes: WorkflowNode[];
  }) => Promise<WorkflowIssuePreflightResult>;
  isPreflighting: boolean;
} {
  const catalog = useExtensionCatalog();
  const queryClient = useQueryClient();
  const store = useStore();
  const generation = useRef(0);
  const active = useRef<ActivePreflight | null>(null);
  const [isPreflighting, setIsPreflighting] = useState(false);

  useUnmountCleanup(() => {
    generation.current += 1;
    active.current?.unsubscribe();
    active.current = null;
  });

  const checkWorkflowIssues = useCallback(
    async ({
      workflowId,
      nodes,
    }: {
      workflowId: string;
      nodes: WorkflowNode[];
    }): Promise<WorkflowIssuePreflightResult> => {
      if (active.current) {
        return { status: "busy" };
      }
      if (store.get(currentWorkflowIdAtom) !== workflowId) {
        return { status: "workflow_changed" };
      }

      const nodeSnapshot = toPersistedNodes(nodes);
      const check: ActivePreflight = {
        generation: ++generation.current,
        workflowId,
        unsubscribe: () => undefined,
      };
      active.current = check;
      setIsPreflighting(true);
      check.unsubscribe = store.sub(currentWorkflowIdAtom, () => {
        if (
          active.current?.generation === check.generation &&
          store.get(currentWorkflowIdAtom) !== check.workflowId
        ) {
          check.unsubscribe();
          active.current = null;
          setIsPreflighting(false);
        }
      });

      try {
        const providerIssues = await fetchProviderFieldIssues(
          queryClient,
          nodeSnapshot,
          catalog
        );
        if (
          active.current?.generation !== check.generation ||
          store.get(currentWorkflowIdAtom) !== workflowId
        ) {
          return { status: "workflow_changed" };
        }

        return {
          status: "ready",
          issues: collectAllWorkflowIssues({
            nodes: nodeSnapshot,
            catalog,
            integrations,
            providerIssues,
          }),
        };
      } catch {
        if (
          active.current?.generation === check.generation &&
          store.get(currentWorkflowIdAtom) === workflowId
        ) {
          toast.error("Could not verify provider-backed fields. Try again.");
          return { status: "unavailable" };
        }
        return { status: "workflow_changed" };
      } finally {
        if (active.current?.generation === check.generation) {
          check.unsubscribe();
          active.current = null;
          setIsPreflighting(false);
        }
      }
    },
    [catalog, integrations, queryClient, store]
  );

  return { checkWorkflowIssues, isPreflighting };
}
