import { useAtomValue, useSetAtom } from "jotai";
import {
  ChevronLeft,
  ChevronRight,
  GitCompareArrows,
  History,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useIsMobile } from "#src/hooks/use-mobile";
import { useWorkflowWorkspaceNavigation } from "#src/hooks/use-workflow-workspace-navigation";
import {
  WorkflowComparisonPropertiesPanel,
  comparisonNodeTitle,
} from "#src/components/workflow/comparison-properties";
import { WorkflowVersionHistory } from "#src/components/workflow/workflow-version-history";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import {
  comparisonSessionAtom,
  resetComparisonLayoutAtom,
  setComparisonSubviewAtom,
} from "#src/lib/workflow-comparison-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { cn } from "@wfgraph/shared/utils";
import type { WorkflowNodeChange } from "@wfgraph/shared/graph/publication-contracts";
import { PanelState } from "#src/components/workflow/workflow-changes-panel-state";
import { useWorkflowComparisonActions } from "#src/components/workflow/use-workflow-comparison-actions";

export function WorkflowChangesPanel({
  actions,
}: {
  actions: ReturnType<typeof useWorkflowComparisonActions>;
}) {
  const catalog = useExtensionCatalog();
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const session = useAtomValue(comparisonSessionAtom);
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const setSubview = useSetAtom(setComparisonSubviewAtom);
  const resetLayout = useSetAtom(resetComparisonLayoutAtom);
  const isMobile = useIsMobile();
  const { openSheet } = useConfigurationSheet();
  const workspaceNavigation = useWorkflowWorkspaceNavigation(
    actions.openComparison
  );

  if (!session) {
    if (actions.isPending) {
      return (
        <PanelState label="Comparing current draft with the published version" />
      );
    }
    if (actions.compare.isError) {
      return (
        <PanelState
          actionLabel="Try again"
          label="Unable to compare changes"
          onAction={() => void actions.openComparison()}
        />
      );
    }
    return (
      <PanelState
        actionLabel="Review changes"
        label="Open a comparison of this draft and its published version."
        onAction={() => void actions.openComparison()}
      />
    );
  }

  const payload = session.payload;
  const selectedIndex = payload.nodeChanges.findIndex(
    (change) => change.nodeId === selectedNodeId
  );
  const layoutChanged = Object.keys(session.positionOverrides).length > 0;

  const selectNodeChange = (change: WorkflowNodeChange) => {
    if (!workflowId) return;
    setSelectedNode(change.nodeId);
    setSubview({ workflowId, subview: "properties" });
    if (isMobile) openSheet();
  };

  const moveSelection = (delta: number) => {
    const next = payload.nodeChanges.at(selectedIndex + delta);
    if (!next || !workflowId) return;
    setSelectedNode(next.nodeId);
  };

  if (session.subview === "history") {
    return <WorkflowVersionHistory actions={actions} />;
  }

  if (session.subview === "properties") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b p-3">
          <Button
            onClick={() =>
              workflowId && setSubview({ workflowId, subview: "review" })
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            <ChevronLeft />
            Back to changes
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkflowComparisonPropertiesPanel />
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="workflow-changes"
    >
      <div className="border-b p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <GitCompareArrows className="size-4" />
            <h2 className="font-semibold text-sm">Review changes</h2>
          </div>
          <div className="flex items-center">
            <Button
              aria-label="Refresh comparison"
              disabled={actions.isPending}
              onClick={() => void actions.openComparison({ force: true })}
              size="icon-sm"
              title="Refresh comparison"
              type="button"
              variant="ghost"
            >
              <RefreshCw />
            </Button>
            <Button
              aria-label="Version history"
              disabled={actions.isPending}
              onClick={() =>
                workflowId && setSubview({ workflowId, subview: "history" })
              }
              size="icon-sm"
              title="Version history"
              type="button"
              variant="ghost"
            >
              <History />
            </Button>
            <Button
              aria-label="Exit comparison"
              onClick={workspaceNavigation.showDraft}
              size="icon-sm"
              title="Exit comparison"
              type="button"
              variant="ghost"
            >
              <X />
            </Button>
          </div>
        </div>
        <p className="mt-2 text-muted-foreground text-xs">
          {versionName(payload.baseVersion?.version)} → proposed version{" "}
          {payload.proposedVersion}
        </p>
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">
            {payload.nodeChanges.length} node change
            {payload.nodeChanges.length === 1 ? "" : "s"};{" "}
            {
              payload.edgeChanges.filter((change) => change.kind === "added")
                .length
            }{" "}
            connection
            {payload.edgeChanges.filter((change) => change.kind === "added")
              .length === 1
              ? ""
              : "s"}{" "}
            added;{" "}
            {
              payload.edgeChanges.filter((change) => change.kind === "removed")
                .length
            }{" "}
            removed
          </p>
          <Button
            aria-label="Reset comparison layout"
            disabled={!layoutChanged}
            onClick={() => workflowId && resetLayout(workflowId)}
            size="icon-sm"
            title="Reset comparison layout"
            type="button"
            variant="ghost"
          >
            <RotateCcw />
          </Button>
        </div>
      </div>
      {actions.isPending ? (
        <p className="border-b px-3 py-2 text-muted-foreground text-xs">
          Refreshing comparison
        </p>
      ) : null}
      {payload.nodeChanges.length === 0 ? (
        <PanelState label="This draft has no node changes." />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="divide-y">
            {payload.nodeChanges.map((change) => (
              <button
                aria-pressed={selectedNodeId === change.nodeId}
                className={cn(
                  "flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-muted",
                  selectedNodeId === change.nodeId && "bg-muted"
                )}
                key={change.nodeId}
                onClick={() => selectNodeChange(change)}
                type="button"
              >
                <ChangeMarker kind={change.kind} />
                <span className="min-w-0 flex-1 truncate font-medium text-xs">
                  {comparisonNodeTitle(catalog, payload, change)}
                </span>
                <span className="text-muted-foreground text-xs">
                  {change.kind}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center justify-between border-t p-3">
        <Button
          onClick={() => moveSelection(-1)}
          disabled={selectedIndex <= 0}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ChevronLeft />
          <span className="sr-only">Previous changed node</span>
        </Button>
        <Button
          onClick={() => moveSelection(1)}
          disabled={selectedIndex >= payload.nodeChanges.length - 1}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ChevronRight />
          <span className="sr-only">Next changed node</span>
        </Button>
      </div>
    </div>
  );
}

function ChangeMarker({ kind }: { kind: WorkflowNodeChange["kind"] }) {
  const letter = kind === "added" ? "A" : kind === "removed" ? "D" : "M";
  const label =
    kind === "added" ? "Added" : kind === "removed" ? "Deleted" : "Modified";
  return (
    <span
      aria-label={label}
      className="grid size-5 shrink-0 place-items-center rounded border font-semibold text-xs"
    >
      {letter}
    </span>
  );
}

function versionName(version: number | undefined): string {
  return version ? `Version ${version}` : "No published version";
}
