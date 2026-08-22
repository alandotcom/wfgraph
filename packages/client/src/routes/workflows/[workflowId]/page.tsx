import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { colorVars } from "@astryxdesign/core/theme/tokens.stylex";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { notifications as toast } from "#src/lib/notifications";
import { ExecutionOverlaySync } from "#src/components/workflow/execution-overlay-sync";
import { WorkflowSidebarPanel } from "#src/components/workflow/workflow-sidebar-panel";
import { useAfterCommit, useDomEvent } from "#src/hooks/effects";
import { isRunInProgress } from "#src/lib/execution-logs";
import { orpcQuery } from "#src/lib/rpc-query";
import {
  edgesAtom,
  isExecutionOverlayActiveAtom,
  nodesAtom,
  setNodeStatusesAtom,
} from "#src/lib/workflow-graph-store";
import {
  currentWorkflowIdAtom,
  lastSaveErrorAtom,
  saveWorkflowAtom,
  workflowNotFoundAtom,
  workflowLoadErrorAtom,
} from "#src/lib/workflow-save-store";
import {
  isExecutingAtom,
  isGeneratingAtom,
  selectedExecutionIdAtom,
} from "#src/lib/workflow-ui-store";

/** How often a run that is still going has its progress read back. */
const RUN_STATUS_POLL_MS = 500;

const WorkflowEditor = () => {
  const isGenerating = useAtomValue(isGeneratingAtom);
  const lastSaveError = useAtomValue(lastSaveErrorAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
  const [selectedExecutionId] = useAtom(selectedExecutionIdAtom);
  const isExecutionOverlayActive = useAtomValue(isExecutionOverlayActiveAtom);
  const setIsExecuting = useSetAtom(isExecutingAtom);
  const saveWorkflow = useSetAtom(saveWorkflowAtom);
  const setNodeStatuses = useSetAtom(setNodeStatusesAtom);
  const workflowNotFound = useAtomValue(workflowNotFoundAtom);
  const workflowLoadError = useAtomValue(workflowLoadErrorAtom);
  const navigate = useNavigate();

  // A debounced autosave has no caller waiting on it, so a failure would
  // otherwise reach only the console while the editor looked saved.
  //
  // Every failure is toasted, including the 400s this used to swallow. Those
  // were half-built nodes the save battery refused, which made the common case
  // of an editor session a silent dropped write; the battery no longer asks, so
  // a 400 here is now something the builder has to be told about.
  useAfterCommit(lastSaveError, () => {
    if (lastSaveError) {
      toast.error(lastSaveError.message || "Failed to save workflow");
    }
  });

  // Keyboard shortcuts
  const handleSave = useCallback(async () => {
    if (!currentWorkflowId || isGenerating) {
      return;
    }
    // Goes through the same queue as autosave, so an in-flight debounced save
    // cannot land afterwards and overwrite what this one just wrote. The queue
    // drives the saving indicator, so there is nothing to bracket here.
    const outcome = await saveWorkflow({ nodes, edges }, { immediate: true });

    if (outcome && !outcome.ok) {
      toast.error(outcome.error.message || "Failed to save workflow");
    }
  }, [currentWorkflowId, nodes, edges, isGenerating, saveWorkflow]);

  // Cmd+S saves. Capture phase, so a focused field in the canvas does not eat
  // it first. Cmd+Enter belongs to the toolbar, which owns the run itself.
  const handleSaveShortcut = useCallback(
    (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        event.stopPropagation();
        void handleSave();
      }
    },
    [handleSave]
  );

  useDomEvent(document, "keydown", handleSaveShortcut, { capture: true });

  // While a run is on screen its progress is read back every half second. The
  // predicate is what stops it: once the run reaches a terminal status there is
  // nothing further to learn, which the hand-managed interval this replaced had
  // to work out for itself in three places, including its error path.
  const executionStatusQuery = useQuery({
    ...orpcQuery.workflow.getExecutionStatus.queryOptions({
      input: { executionId: selectedExecutionId ?? "" },
    }),
    enabled: selectedExecutionId !== null,
    staleTime: 0,
    refetchIntervalInBackground: false,
    refetchInterval: (query) =>
      isRunInProgress(query.state.data?.status) ? RUN_STATUS_POLL_MS : false,
  });

  const executionStatus = executionStatusQuery.data;

  // Projecting a run's progress onto the graph. The statuses live on the nodes
  // because that is where React Flow reads them from, so this is a write into a
  // store rather than something render can return, and the thing it follows is
  // a server response rather than anything the user did. Overlay presence is in
  // the key so a null→present rebuild (late hydrate restore) re-projects chips
  // onto the new nodes; completed runs do not poll, so identity alone is not enough.
  const nodeStatusKey =
    executionStatus?.nodeStatuses
      .map((nodeStatus) => `${nodeStatus.nodeId}=${nodeStatus.status}`)
      .join(",") ?? "";
  useAfterCommit(
    selectedExecutionId === null
      ? "idle"
      : `${selectedExecutionId}:${isExecutionOverlayActive}:${
          executionStatus === undefined
            ? "loading"
            : `${executionStatus.status}:${nodeStatusKey}`
        }`,
    () => {
      if (!selectedExecutionId) {
        setNodeStatuses(
          nodes.map((node) => ({ nodeId: node.id, status: "idle" }))
        );
        setIsExecuting(false);
        return;
      }

      if (!executionStatus) {
        return;
      }

      setNodeStatuses(
        executionStatus.nodeStatuses.map((nodeStatus) => ({
          nodeId: nodeStatus.nodeId,
          status: nodeStatus.status === "pending" ? "idle" : nodeStatus.status,
        }))
      );
      setIsExecuting(isRunInProgress(executionStatus.status));
    }
  );

  return (
    <div {...stylex.props(styles.editor)}>
      {/* URL → selection + pinned-graph overlay. Sibling of the sidebar so it
          outlives the Runs panel; the status projection above reads what it writes. */}
      <ExecutionOverlaySync />

      {/* Workflow not found overlay */}
      {workflowNotFound && (
        <div {...stylex.props(styles.messageBackdrop)}>
          <Card padding={6} xstyle={styles.messageCard}>
            <VStack align="center" gap={4}>
              <Text type="display-3">Workflow not found</Text>
              <Text color="secondary">
                The workflow you're looking for doesn't exist or has been
                deleted.
              </Text>
              <Button
                label="Go to dashboard"
                onClick={() => void navigate({ to: "/" })}
                variant="primary"
              />
            </VStack>
          </Card>
        </div>
      )}

      {workflowLoadError && (
        <div {...stylex.props(styles.messageBackdrop)}>
          <Card padding={6} xstyle={styles.messageCard}>
            <VStack align="center" gap={4}>
              <Text type="display-3">Couldn't load workflow</Text>
              <Text color="secondary">{workflowLoadError}</Text>
              <Button
                label="Try again"
                onClick={() => window.location.reload()}
                variant="primary"
              />
            </VStack>
          </Card>
        </div>
      )}

      <WorkflowSidebarPanel />
    </div>
  );
};

export default WorkflowEditor;

const styles = stylex.create({
  editor: {
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
    overflow: "hidden",
    width: "100%",
  },
  messageBackdrop: {
    alignItems: "center",
    backgroundColor: colorVars["--color-background-muted"],
    display: "flex",
    inset: 0,
    justifyContent: "center",
    pointerEvents: "auto",
    position: "absolute",
    zIndex: 20,
  },
  messageCard: {
    maxWidth: 480,
    textAlign: "center",
    width: "calc(100% - 2rem)",
  },
});
