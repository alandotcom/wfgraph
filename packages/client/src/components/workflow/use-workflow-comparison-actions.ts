import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import { toast } from "sonner";
import {
  edgesAtom,
  installRestoredWorkflowAtom,
  nodesAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import {
  beginWorkflowComparisonRequestAtom,
  comparisonSessionAtom,
  installWorkflowComparisonAtom,
  isComparisonErrorAtom,
  isComparisonPendingAtom,
  settleWorkflowComparisonRequestAtom,
} from "#src/lib/workflow-comparison-store";
import { toSavedWorkflow, toSerializedGraph } from "#src/lib/rpc-client";
import {
  cacheWorkflow,
  orpcQuery,
  refreshWorkflowList,
} from "#src/lib/rpc-query";
import {
  currentWorkflowIdAtom,
  saveWorkflowAtom,
} from "#src/lib/workflow-save-store";
import { enterDraftWorkspaceAtom } from "#src/lib/workflow-workspace-navigation";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
export function useWorkflowComparisonActions() {
  const queryClient = useQueryClient();
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const session = useAtomValue(comparisonSessionAtom);
  const install = useSetAtom(installWorkflowComparisonAtom);
  const installRestoredWorkflow = useSetAtom(installRestoredWorkflowAtom);
  const enterDraft = useSetAtom(enterDraftWorkspaceAtom);
  const saveWorkflow = useSetAtom(saveWorkflowAtom);
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const beginRequest = useSetAtom(beginWorkflowComparisonRequestAtom);
  const settleRequest = useSetAtom(settleWorkflowComparisonRequestAtom);
  const isPending = useAtomValue(isComparisonPendingAtom);
  const isError = useAtomValue(isComparisonErrorAtom);

  const compare = useMutation(
    orpcQuery.workflow.compareVersion.mutationOptions({
      meta: { errorMessage: "Unable to compare workflow changes" },
    })
  );

  const openComparison = async (options?: {
    baseVersionId?: string;
    force?: boolean;
    fresh?: boolean;
  }) => {
    if (
      !workflowId ||
      (session && !options?.force && !options?.fresh && !options?.baseVersionId)
    ) {
      return;
    }
    const baseVersionId =
      options?.baseVersionId ??
      (options?.force && !options.fresh
        ? session?.payload.baseVersion?.id
        : undefined);
    const epoch = beginRequest(workflowId);
    let outcome: "success" | "error" = "success";
    try {
      const payload = await compare.mutateAsync({
        workflowId,
        ...(baseVersionId ? { baseVersionId } : {}),
        draftGraph: toSerializedGraph({ nodes, edges }),
      });
      const installed = install({
        workflowId,
        epoch,
        payload,
        preserveSession: options?.fresh ? false : Boolean(session),
        ...(baseVersionId ? { selectedHistoryVersionId: baseVersionId } : {}),
      });
      if (
        installed &&
        selectedNodeId &&
        !toWorkflowGraphData(payload.baseGraph).nodes.some(
          (node) => node.id === selectedNodeId
        ) &&
        !toWorkflowGraphData(payload.draftGraph).nodes.some(
          (node) => node.id === selectedNodeId
        )
      ) {
        setSelectedNode(null);
      }
    } catch {
      outcome = "error";
      // Mutation metadata reports this failure. Event handlers may discard
      // this promise because opening a comparison has completed as a UI outcome.
    } finally {
      settleRequest({ workflowId, epoch, outcome });
    }
  };

  const restoreVersionOptions =
    orpcQuery.workflow.restoreVersion.mutationOptions();
  const restore = useMutation({
    ...restoreVersionOptions,
    mutationFn: async (input, context) => {
      const saved = await saveWorkflow({ nodes, edges }, { immediate: true });
      if (!saved?.ok) {
        throw saved?.error ?? new Error("Unable to save the current draft");
      }
      return await restoreVersionOptions.mutationFn!(input, context);
    },
    onSuccess: async (payload, variables) => {
      const workflow = toSavedWorkflow(payload);
      cacheWorkflow(queryClient, payload);
      await refreshWorkflowList(queryClient);
      if (
        installRestoredWorkflow({
          expectedWorkflowId: variables.workflowId,
          workflow,
        })
      ) {
        enterDraft();
        toast.success("Version restored as draft");
      }
    },
    meta: { errorMessage: "Unable to restore this version as a draft" },
  });

  return { compare, isError, isPending, openComparison, restore };
}
