import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { toast } from "sonner";
import {
  edgesAtom,
  installRestoredWorkflowAtom,
  nodesAtom,
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
import { isNotFoundError } from "#src/lib/workflow-route-state";
import {
  cacheWorkflow,
  orpcQuery,
  refreshWorkflowList,
} from "#src/lib/rpc-query";
import {
  currentWorkflowIdAtom,
  saveWorkflowAtom,
} from "#src/lib/workflow-save-store";
import { rememberedRouteSearchesAtom } from "#src/lib/workflow-workspace-navigation";
import { can } from "#src/lib/authorization";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

export function useWorkflowComparisonActions() {
  const queryClient = useQueryClient();
  const store = useStore();
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const session = useAtomValue(comparisonSessionAtom);
  const install = useSetAtom(installWorkflowComparisonAtom);
  const installRestoredWorkflow = useSetAtom(installRestoredWorkflowAtom);
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const rememberedSearches = useAtomValue(rememberedRouteSearchesAtom);
  const saveWorkflow = useSetAtom(saveWorkflowAtom);
  const beginRequest = useSetAtom(beginWorkflowComparisonRequestAtom);
  const settleRequest = useSetAtom(settleWorkflowComparisonRequestAtom);
  const isPending = useAtomValue(isComparisonPendingAtom);
  const isError = useAtomValue(isComparisonErrorAtom);
  const canCompare = can(WfGraphOperations.workflowCompareVersion.id);
  // Restore saves the existing draft before restoring a version.
  const canRestore =
    can(WfGraphOperations.workflowRestoreVersion.id) &&
    can(WfGraphOperations.workflowUpdate.id);

  const compare = useMutation(
    orpcQuery.workflow.compareVersion.mutationOptions({
      meta: { errorMessage: "Unable to compare workflow changes" },
    })
  );

  /**
   * Compare the draft with a published version. With no options this opens a
   * comparison only when none is installed. `baseVersionId` compares against
   * that version, `current` against the current publication, and `force`
   * refreshes the installed comparison against its own base. A base version
   * the server does not have settles with its id, which route recovery answers.
   * A response for a base other than the one the Changes route names by then
   * is dropped, and `WorkspaceRouteSync` drops selected ids the installed
   * comparison graph does not hold.
   */
  const openComparison = async (options?: {
    baseVersionId?: string;
    current?: boolean;
    force?: boolean;
  }) => {
    if (
      !canCompare ||
      !workflowId ||
      (session &&
        !options?.force &&
        !options?.current &&
        !options?.baseVersionId)
    ) {
      return;
    }
    const baseVersionId =
      options?.baseVersionId ??
      (options?.force && !options.current
        ? session?.payload.baseVersion?.id
        : undefined);
    const epoch = beginRequest(workflowId, baseVersionId ?? null);
    let outcome: "success" | "error" = "success";
    let missingBaseVersionId: string | undefined;
    try {
      const graph = {
        nodes: store.get(nodesAtom),
        edges: store.get(edgesAtom),
      };
      const payload = await compare.mutateAsync(
        omitUndefined({
          workflowId,
          baseVersionId,
          draftGraph: toSerializedGraph(graph),
        })
      );
      install({
        workflowId,
        epoch,
        payload,
        preserveSession: Boolean(session),
        selectedHistoryVersionId: baseVersionId,
      });
    } catch (error) {
      outcome = "error";
      if (isNotFoundError(error)) {
        missingBaseVersionId = baseVersionId;
      }
      // Mutation metadata reports this failure. Event handlers may discard
      // this promise because opening a comparison has completed as a UI outcome.
    } finally {
      settleRequest({ workflowId, epoch, outcome, missingBaseVersionId });
    }
  };

  const restoreVersionOptions =
    orpcQuery.workflow.restoreVersion.mutationOptions();
  const restore = useMutation({
    ...restoreVersionOptions,
    mutationFn: async (input, context) => {
      if (!canRestore) {
        throw new Error("You do not have permission to restore this version.");
      }
      const graph = {
        nodes: store.get(nodesAtom),
        edges: store.get(edgesAtom),
      };
      const saved = await saveWorkflow(graph, { immediate: true });
      if (!saved?.ok) {
        throw saved?.error ?? new Error("Unable to save the current draft");
      }
      return await restoreVersionOptions.mutationFn!(
        {
          ...input,
          expectedDraftRevision: saved.workflow.draftRevision,
        },
        context
      );
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
        void navigate({
          search: rememberedSearches.draft ?? {},
          replace: true,
        });
        toast.success("Version restored as draft");
      }
    },
    meta: { errorMessage: "Unable to restore this version as a draft" },
  });

  return {
    canCompare,
    canRestore,
    compare,
    isError,
    isPending,
    openComparison,
    restore,
  };
}
