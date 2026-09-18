import { partition } from "es-toolkit/array";
import { isEmptyObject } from "es-toolkit/predicate";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  ArrowLeft,
  ArrowRight,
  History,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { type RefObject, useMemo, useRef } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { ComparisonMarker } from "#src/components/flow-elements/comparison-marker";
import { Button } from "#src/components/ui/button";
import { useWorkflowComparisonActions } from "#src/components/workflow/use-workflow-comparison-actions";
import { PanelState } from "#src/components/workflow/workflow-changes-panel-state";
import { WorkflowVersionHistory } from "#src/components/workflow/workflow-version-history";
import { useAfterCommit } from "#src/hooks/effects";
import { useWorkflowWorkspaceNavigation } from "#src/hooks/use-workflow-workspace-navigation";
import {
  comparisonDisplayGraphAtom,
  comparisonSessionAtom,
  resetComparisonLayoutAtom,
  setComparisonSubviewAtom,
} from "#src/lib/workflow-comparison-store";
import {
  workspaceAddressId,
  type WorkspaceAddress,
} from "#src/lib/workflow-navigation-state";
import { COMPARISON_CHANGE_KIND_LABEL } from "#src/lib/workflow-graph-types";
import { currentWorkflowNameAtom } from "#src/lib/workflow-save-store";
import {
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
} from "#src/lib/workflow-workspace-navigation";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import { cn } from "@wfgraph/shared/utils";
import {
  changedObjects,
  changeSelection,
  changesHeaderModel,
  comparisonRevealContextAtom,
  describeChangeCounts,
  selectedChangeIndex,
  type ChangedObject,
  type ComparisonShownStatus,
  type ComparisonWaitingStatus,
} from "./changes-summary";
import { RevealHeader } from "./reveal-header";
import type { RevealBodyProps, RevealKindHeaderProps } from "./reveal-kinds";
import { useInspectorScroll } from "./use-inspector-scroll";

type ComparisonActions = ReturnType<typeof useWorkflowComparisonActions>;

/**
 * The Changes header: the comparison's name and path, and what its latest
 * request is doing. It reads the comparison itself, so the shell passes only
 * its level controls.
 */
export function ChangesHeader({ level, controls }: RevealKindHeaderProps) {
  const comparison = useAtomValue(comparisonRevealContextAtom);
  const workflowName = useAtomValue(currentWorkflowNameAtom);
  return (
    <RevealHeader
      controls={controls}
      level={level}
      model={changesHeaderModel({ comparison, workflowName })}
    />
  );
}

/**
 * Changes Browse: the comparison's summary and controls, then either the list
 * of changed nodes and connections or version history. A comparison against
 * another base than the address names is never shown, so its loading or error
 * state stands until the named comparison is installed.
 */
export function ChangesBrowse(_props: RevealBodyProps) {
  const actions = useWorkflowComparisonActions();
  const comparison = useAtomValue(comparisonRevealContextAtom);
  const address = useAtomValue(activeWorkspaceAddressAtom);
  const historyHeadingRef = useRef<HTMLHeadingElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const showsHistory = "payload" in comparison && comparison.showsHistory;

  // Opening or leaving version history unmounts the control that did it, so
  // focus moves to the history heading, or back to Version history. The view
  // the body mounts with leaves focus alone.
  const shownHistoryRef = useRef(showsHistory);
  useAfterCommit(showsHistory, () => {
    if (showsHistory === shownHistoryRef.current) {
      return;
    }
    shownHistoryRef.current = showsHistory;
    (showsHistory
      ? historyHeadingRef.current
      : historyButtonRef.current
    )?.focus();
  });

  if (showsHistory) {
    return (
      <WorkflowVersionHistory
        actions={actions}
        headingRef={historyHeadingRef}
      />
    );
  }
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="workflow-changes"
    >
      <ChangesControls
        actions={actions}
        address={address}
        historyButtonRef={historyButtonRef}
      />
      {"payload" in comparison ? (
        <ChangeList
          address={address}
          payload={comparison.payload}
          status={comparison.status}
        />
      ) : (
        <ComparisonState
          actions={actions}
          address={address}
          status={comparison.status}
        />
      )}
    </div>
  );
}

/**
 * Refresh, version history, layout reset, and exit. Reset shows only while a
 * removed step has been moved, since there is nothing to reset otherwise, and
 * hands focus to Version history as it goes.
 */
function ChangesControls({
  actions,
  address,
  historyButtonRef,
}: {
  actions: ComparisonActions;
  address: WorkspaceAddress;
  historyButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const comparison = useAtomValue(comparisonRevealContextAtom);
  const session = useAtomValue(comparisonSessionAtom);
  const setSubview = useSetAtom(setComparisonSubviewAtom);
  const resetLayout = useSetAtom(resetComparisonLayoutAtom);
  const { showDraft } = useWorkflowWorkspaceNavigation();
  const shown = "payload" in comparison;
  const unavailable = !shown || actions.isPending;
  const layoutChanged =
    shown && session !== null && !isEmptyObject(session.positionOverrides);

  return (
    <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
      <Button
        aria-label="Refresh comparison"
        disabled={unavailable || !actions.canCompare}
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
        disabled={unavailable}
        onClick={() =>
          setSubview({ workflowId: address.workflowId, subview: "history" })
        }
        ref={historyButtonRef}
        size="icon-sm"
        title="Version history"
        type="button"
        variant="ghost"
      >
        <History />
      </Button>
      {layoutChanged ? (
        <Button
          aria-label="Reset comparison layout"
          onClick={() => {
            resetLayout(address.workflowId);
            historyButtonRef.current?.focus();
          }}
          size="icon-sm"
          title="Reset comparison layout"
          type="button"
          variant="ghost"
        >
          <RotateCcw />
        </Button>
      ) : null}
      <Button
        className="ml-auto"
        onClick={showDraft}
        size="sm"
        type="button"
        variant="ghost"
      >
        <X data-icon="inline-start" />
        Exit comparison
      </Button>
    </div>
  );
}

/** What Browse shows while the comparison the address names is not installed. */
function ComparisonState({
  actions,
  address,
  status,
}: {
  actions: ComparisonActions;
  address: WorkspaceAddress;
  status: ComparisonWaitingStatus;
}) {
  const baseVersionId =
    address.key.workspace === "changes" ? address.key.baseVersionId : null;
  const open = () =>
    void actions.openComparison(
      baseVersionId === null ? undefined : { baseVersionId }
    );
  if (status === "loading") {
    return (
      <PanelState label="Comparing current draft with the published version" />
    );
  }
  const canOpen = actions.canCompare;
  return status === "error" ? (
    <PanelState
      actionLabel={canOpen ? "Try again" : undefined}
      label="Unable to compare changes"
      onAction={canOpen ? open : undefined}
    />
  ) : (
    <PanelState
      actionLabel={canOpen ? "Review changes" : undefined}
      label="Open a comparison of this draft and its published version."
      onAction={canOpen ? open : undefined}
    />
  );
}

const LIVE_STATUS: Record<ComparisonShownStatus, string> = {
  ready: "",
  refreshing: "Refreshing comparison",
  "refresh-failed": "Unable to refresh this comparison",
};

/**
 * The comparison's counts, its changed nodes then connections, and Previous and
 * Next. Choosing a row selects that object on the canvas, which places it. The
 * list keeps its scroll for the address, and a selection made anywhere scrolls
 * its row into view.
 */
function ChangeList({
  address,
  payload,
  status,
}: {
  address: WorkspaceAddress;
  payload: WorkflowComparisonPayload;
  status: ComparisonShownStatus;
}) {
  const catalog = useExtensionCatalog();
  const graph = useAtomValue(comparisonDisplayGraphAtom);
  const [selection, setSelection] = useAtom(activeSelectionAtom);
  const objects = useMemo(
    () => (graph ? changedObjects({ payload, graph, catalog }) : []),
    [catalog, graph, payload]
  );
  const [nodeObjects, edgeObjects] = partition(
    objects,
    (item) => item.object.kind === "node"
  );
  const selectedIndex = selectedChangeIndex(objects, selection);
  const selectedKey = objects[selectedIndex]?.key ?? null;
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const {
    ref: scrollRef,
    onScroll,
    onScrollEnd,
    adoptScroll,
  } = useInspectorScroll({
    address,
    addressId: workspaceAddressId(address),
    inspectedId: null,
    level: "browse",
  });

  // A selection that changes while the list is shown brings its row into view.
  // The selection the list mounts with keeps the restored scroll.
  const shownKeyRef = useRef(selectedKey);
  useAfterCommit(selectedKey, () => {
    if (selectedKey === shownKeyRef.current) {
      return;
    }
    shownKeyRef.current = selectedKey;
    const row = selectedKey === null ? null : rows.current.get(selectedKey);
    if (row) {
      row.scrollIntoView?.({ block: "nearest" });
      adoptScroll();
    }
  });

  const select = (item: ChangedObject | undefined) => {
    if (item) {
      setSelection(changeSelection(item.object));
    }
  };

  const renderRows = (items: readonly ChangedObject[]) =>
    items.map((item) => {
      const pressed = item.key === selectedKey;
      return (
        <button
          aria-pressed={pressed}
          className={cn(
            "flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-muted",
            pressed && "bg-muted"
          )}
          data-change={item.change}
          key={item.key}
          onClick={() => select(item)}
          ref={(element) => {
            if (element) {
              rows.current.set(item.key, element);
            } else {
              rows.current.delete(item.key);
            }
          }}
          type="button"
        >
          <ComparisonMarker
            className="static shrink-0"
            comparison={{ kind: item.change }}
          />
          <span className="min-w-0 flex-1 truncate font-medium text-xs">
            {item.title}
          </span>
          <span className="shrink-0 text-muted-foreground text-xs">
            {COMPARISON_CHANGE_KIND_LABEL[item.change]}
          </span>
        </button>
      );
    });

  return (
    <>
      <section
        aria-label="Comparison summary"
        className="shrink-0 border-b px-4 py-3"
      >
        <dl className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground text-xs">Steps</dt>
            <dd className="text-right text-xs">
              {describeChangeCounts(payload.nodeChanges)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground text-xs">Connections</dt>
            <dd className="text-right text-xs">
              {describeChangeCounts(payload.edgeChanges)}
            </dd>
          </div>
        </dl>
        <p aria-live="polite" className="sr-only">
          {LIVE_STATUS[status]}
        </p>
      </section>
      {objects.length === 0 ? (
        <PanelState
          label={
            payload.baseVersion
              ? `This draft has no changes from version ${payload.baseVersion.version}.`
              : "This draft has no steps to publish."
          }
        />
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          data-slot="change-list"
          onScroll={onScroll}
          onScrollEnd={onScrollEnd}
          ref={scrollRef}
        >
          {nodeObjects.length > 0 ? (
            <section aria-label="Changed steps">
              <h3 className="border-b bg-muted/30 px-4 py-1.5 font-medium text-muted-foreground text-xs">
                Steps
              </h3>
              <div className="divide-y">{renderRows(nodeObjects)}</div>
            </section>
          ) : null}
          {edgeObjects.length > 0 ? (
            <section aria-label="Changed connections">
              <h3 className="border-y bg-muted/30 px-4 py-1.5 font-medium text-muted-foreground text-xs">
                Connections
              </h3>
              <div className="divide-y">{renderRows(edgeObjects)}</div>
            </section>
          ) : null}
        </div>
      )}
      <nav
        aria-label="Changed objects"
        className="flex shrink-0 items-center justify-between border-t px-2 py-1.5"
      >
        <Button
          aria-label="Previous change"
          disabled={selectedIndex <= 0}
          onClick={() => select(objects[selectedIndex - 1])}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ArrowLeft data-icon="inline-start" />
          Previous
        </Button>
        <span className="text-muted-foreground text-xs">
          {selectedIndex >= 0
            ? `${selectedIndex + 1} of ${objects.length}`
            : `${objects.length} ${objects.length === 1 ? "change" : "changes"}`}
        </span>
        <Button
          aria-label="Next change"
          disabled={selectedIndex >= objects.length - 1}
          onClick={() => select(objects[selectedIndex + 1])}
          size="sm"
          type="button"
          variant="ghost"
        >
          Next
          <ArrowRight data-icon="inline-end" />
        </Button>
      </nav>
    </>
  );
}
