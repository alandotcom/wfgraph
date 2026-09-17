import { isEmptyObject } from "es-toolkit/predicate";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { History, RefreshCw, RotateCcw, X } from "lucide-react";
import { type RefObject, useMemo, useRef } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { ComparisonMarker } from "#src/components/flow-elements/comparison-marker";
import { Button } from "#src/components/ui/button";
import { useWorkflowComparisonActions } from "#src/components/workflow/use-workflow-comparison-actions";
import { PanelState } from "#src/components/workflow/panel-state";
import { WorkflowVersionHistory } from "#src/components/workflow/workflow-version-history";
import { useAfterCommit, useAfterPaint } from "#src/hooks/effects";
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
import { selectedObject } from "#src/lib/canvas-selection";
import {
  comparisonSummary,
  ORGANIZATION_ONLY_STATEMENT,
} from "#src/lib/workflow-change-summary";
import { currentWorkflowNameAtom } from "#src/lib/workflow-save-store";
import {
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
} from "#src/lib/workflow-workspace-navigation";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import { cn } from "@wfgraph/shared/utils";
import {
  ChangeNavigation,
  useChangedObjects,
  useSelectChange,
  type ChooseChange,
} from "./changes-navigation";
import {
  changeListSections,
  changeRowFocusRequestAtom,
  changesHeaderModel,
  comparisonRevealContextAtom,
  inspectChange,
  noChangesLabel,
  type ChangedObject,
  type ComparisonShownStatus,
  type ComparisonWaitingStatus,
} from "./changes-summary";
import { RevealHeader } from "./reveal-header";
import type { RevealBodyProps, RevealKindHeaderProps } from "./reveal-kinds";
import { useInspectorScroll } from "./use-inspector-scroll";

type ComparisonActions = ReturnType<typeof useWorkflowComparisonActions>;

/**
 * The Changes header: the comparison's name and path, what its latest request
 * is doing, and at Focus the title of the inspected object. It reads the
 * comparison and selection itself, so the shell passes only its level controls.
 */
export function ChangesHeader({ level, controls }: RevealKindHeaderProps) {
  const comparison = useAtomValue(comparisonRevealContextAtom);
  const workflowName = useAtomValue(currentWorkflowNameAtom);
  const graph = useAtomValue(comparisonDisplayGraphAtom);
  const selection = useAtomValue(activeSelectionAtom);
  const catalog = useExtensionCatalog();
  const object = selectedObject(selection);
  const objectKind = object?.kind;
  const objectId = object?.id;
  const payload = "payload" in comparison ? comparison.payload : null;
  const inspectedTitle = useMemo(() => {
    if (
      level !== "focus" ||
      payload === null ||
      graph === null ||
      objectKind === undefined ||
      objectId === undefined
    ) {
      return null;
    }
    const inspection = inspectChange({
      payload,
      graph,
      catalog,
      objects: [],
      object: { kind: objectKind, id: objectId },
    });
    return inspection.kind === "unavailable" ? null : inspection.title;
  }, [catalog, graph, level, objectId, objectKind, payload]);
  return (
    <RevealHeader
      controls={controls}
      level={level}
      model={changesHeaderModel({
        comparison,
        workflowName,
        level,
        inspectedTitle,
      })}
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
  const showsList = "payload" in comparison && !comparison.showsHistory;
  const rowFocusRequest = useAtomValue(changeRowFocusRequestAtom);
  const setRowFocusRequest = useSetAtom(changeRowFocusRequestAtom);
  const setSubview = useSetAtom(setComparisonSubviewAtom);

  // A row focus request is for the change list alone. Without the list it is
  // dropped, so it cannot take focus when the list mounts later.
  const unusedRequest = showsList ? null : rowFocusRequest;
  useAfterCommit(unusedRequest, () => {
    if (unusedRequest !== null) {
      setRowFocusRequest(null);
    }
  });

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
        onBack={() =>
          setSubview({ workflowId: address.workflowId, subview: "review" })
        }
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

/**
 * What a Changes body shows while the comparison the address names is not
 * installed: loading, a retryable failure, or the offer to open one.
 */
export function ComparisonState({
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

/** Whether any part of `row` lies outside the visible area of `scroller`. */
function isOutsideScroller(row: HTMLElement, scroller: HTMLElement): boolean {
  const rowBox = row.getBoundingClientRect();
  const scrollerBox = scroller.getBoundingClientRect();
  return rowBox.top < scrollerBox.top || rowBox.bottom > scrollerBox.bottom;
}

const LIVE_STATUS: Record<ComparisonShownStatus, string> = {
  ready: "",
  refreshing: "Refreshing comparison",
  "refresh-failed": "Unable to refresh this comparison",
};

/** A label and value row of the comparison summary. */
function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-right text-xs">{value}</dd>
    </div>
  );
}

/**
 * The comparison's counts under Behavior and Organization. A comparison whose
 * only changes are Group organization says that execution behavior is
 * unchanged in place of the Behavior counts.
 */
export function ComparisonSummarySection({
  payload,
  status,
}: {
  payload: WorkflowComparisonPayload;
  status: ComparisonShownStatus;
}) {
  const summary = comparisonSummary(payload);
  const heading = "font-medium text-muted-foreground text-xs";
  return (
    <section
      aria-label="Comparison summary"
      className="shrink-0 space-y-3 border-b px-4 py-3"
    >
      <div className="space-y-1.5">
        <h3 className={heading}>Behavior</h3>
        {summary.behavior ? (
          <dl className="space-y-1.5">
            <SummaryRow label="Steps" value={summary.behavior.steps} />
            <SummaryRow
              label="Connections"
              value={summary.behavior.connections}
            />
          </dl>
        ) : (
          <p className="text-xs" data-state="behavior-unchanged">
            {ORGANIZATION_ONLY_STATEMENT}
          </p>
        )}
      </div>
      {summary.organization ? (
        <div className="space-y-1.5">
          <h3 className={heading}>Organization</h3>
          <dl className="space-y-1.5">
            <SummaryRow label="Groups" value={summary.organization.groups} />
            <SummaryRow
              label="Group membership"
              value={summary.organization.membership}
            />
          </dl>
        </div>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {LIVE_STATUS[status]}
      </p>
    </section>
  );
}

/**
 * The comparison's counts, its changed Groups, steps, then connections, and
 * Previous and Next. Choosing a row selects that object on the canvas, which places it, and
 * Compare fields in the header shows it in Focus. The list keeps its scroll for
 * the address, and a selection made anywhere scrolls its row into view.
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
  const { objects, selectedIndex, selectedKey } = useChangedObjects(payload);
  const select = useSelectChange();
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const store = useStore();
  const addressId = workspaceAddressId(address);
  const {
    ref: scrollRef,
    onScroll,
    onScrollEnd,
    adoptScroll,
  } = useInspectorScroll({
    address,
    addressId,
    inspectedId: null,
    level: "browse",
  });

  // Back from Focus mounts the list with its restored scroll, then hands DOM
  // focus to the row of the object Focus showed. A row outside the list's
  // visible area, which Previous and Next in Focus can select, is scrolled
  // into view first and that scroll is kept.
  useAfterPaint(addressId, () => {
    if (store.get(changeRowFocusRequestAtom) !== addressId) {
      return;
    }
    store.set(changeRowFocusRequestAtom, null);
    const row = selectedKey === null ? null : rows.current.get(selectedKey);
    if (!row) {
      return;
    }
    const scroller = scrollRef.current;
    if (scroller && isOutsideScroller(row, scroller)) {
      row.scrollIntoView?.({ block: "nearest" });
      adoptScroll();
    }
    row.focus({ preventScroll: true });
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

  return (
    <>
      <ComparisonSummarySection payload={payload} status={status} />
      {objects.length === 0 ? (
        <PanelState label={noChangesLabel(payload)} />
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          data-slot="change-list"
          onScroll={onScroll}
          onScrollEnd={onScrollEnd}
          ref={scrollRef}
        >
          <ChangeListSections
            objects={objects}
            onChoose={select}
            rows={rows}
            selectedKey={selectedKey}
          />
        </div>
      )}
      <ChangeNavigation
        objects={objects}
        onSelect={select}
        selectedIndex={selectedIndex}
      />
    </>
  );
}

/**
 * The change list's sections of changed Groups, steps, then connections, one
 * row per object. Choosing a row calls `onChoose`, and the row of `selectedKey`
 * is pressed. `rows`, when given, holds each mounted row by its object's key.
 */
export function ChangeListSections({
  objects,
  selectedKey,
  onChoose,
  rows,
}: {
  objects: readonly ChangedObject[];
  selectedKey: string | null;
  onChoose: ChooseChange;
  rows?: RefObject<Map<string, HTMLButtonElement>> | undefined;
}) {
  return changeListSections(objects).map((section, index) => (
    <section aria-label={section.label} key={section.id}>
      <h3
        className={cn(
          "border-b bg-muted/30 px-4 py-1.5 font-medium text-muted-foreground text-xs",
          index > 0 && "border-t"
        )}
      >
        {section.title}
      </h3>
      <div className="divide-y">
        {section.items.map((item) => {
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
              onClick={() => onChoose(item)}
              ref={(element) => {
                if (element) {
                  rows?.current.set(item.key, element);
                } else {
                  rows?.current.delete(item.key);
                }
              }}
              type="button"
            >
              <ComparisonMarker
                className="static shrink-0"
                comparison={{ kind: item.change }}
              />
              {/* A phone's row reads at body size, and Browse's at caption size. */}
              <span className="min-w-0 flex-1 truncate font-medium text-sm md:text-xs">
                {item.title}
              </span>
              <span className="shrink-0 text-muted-foreground text-xs">
                {item.detail}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  ));
}
