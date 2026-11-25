import { isEmptyObject } from "es-toolkit/predicate";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronRight, History, RefreshCw, RotateCcw, X } from "lucide-react";
import { type RefObject, useId, useRef } from "react";
import { ComparisonMarker } from "#src/components/flow-elements/comparison-marker";
import { Button } from "#src/components/ui/button";
import type { ComparisonLayout } from "#src/components/workflow/comparison-properties";
import { useWorkflowComparisonActions } from "#src/components/workflow/use-workflow-comparison-actions";
import { StatusPlaceholder } from "#src/components/workflow/status-placeholder";
import {
  RestoreVersionControl,
  WorkflowVersionHistory,
} from "#src/components/workflow/workflow-version-history";
import { useAfterCommit } from "#src/hooks/effects";
import { useWorkflowWorkspaceNavigation } from "#src/hooks/use-workflow-workspace-navigation";
import {
  comparisonSessionAtom,
  resetComparisonLayoutAtom,
  setComparisonSubviewAtom,
} from "#src/lib/workflow-comparison-store";
import {
  workspaceAddressId,
  type WorkspaceAddress,
} from "#src/lib/workflow-navigation-state";
import {
  comparisonSummary,
  ORGANIZATION_ONLY_STATEMENT,
} from "#src/lib/workflow-change-summary";
import { currentWorkflowNameAtom } from "#src/lib/workflow-save-store";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import { cn } from "@wfgraph/shared/utils";
import { ChangeDifferences } from "./change-differences";
import {
  useChangedObjects,
  useOpenChangeRows,
  useSelectChange,
  type ChooseChange,
} from "./changes-navigation";
import {
  changeListSections,
  changesHeaderModel,
  comparisonIdentity,
  comparisonRevealContextAtom,
  noChangesLabel,
  opensInPlace,
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
 * its controls.
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
  const setSubview = useSetAtom(setComparisonSubviewAtom);

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
        <>
          <EarlierVersionRestore
            actions={actions}
            payload={comparison.payload}
          />
          <ChangeList
            address={address}
            payload={comparison.payload}
            status={comparison.status}
          />
        </>
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
        disabled={unavailable}
        onClick={() =>
          setSubview({ workflowId: address.workflowId, subview: "history" })
        }
        ref={historyButtonRef}
        size="sm"
        type="button"
        variant="ghost"
      >
        <History data-icon="inline-start" />
        Version history
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
 * Restore for a comparison against a version other than the current
 * publication, which is how choosing a version in history lands: its change
 * list with Restore in reach. A comparison against the current publication
 * leaves Restore to version history.
 */
function EarlierVersionRestore({
  actions,
  payload,
}: {
  actions: ComparisonActions;
  payload: WorkflowComparisonPayload;
}) {
  const base = payload.baseVersion;
  if (base === null || base.isCurrent || !actions.canRestore) return null;
  return (
    <div className="shrink-0 border-b px-4 py-2">
      <RestoreVersionControl actions={actions} version={base} />
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
      <StatusPlaceholder label="Comparing current draft with the published version" />
    );
  }
  const canOpen = actions.canCompare;
  return status === "error" ? (
    <StatusPlaceholder
      actionLabel={canOpen ? "Try again" : undefined}
      label="Unable to compare changes"
      onAction={canOpen ? open : undefined}
    />
  ) : (
    <StatusPlaceholder
      actionLabel={canOpen ? "Review changes" : undefined}
      label="Open a comparison of this draft and its published version."
      onAction={canOpen ? open : undefined}
    />
  );
}

/** Whether any part of `element` lies outside the visible area of `scroller`. */
function isOutsideScroller(
  element: HTMLElement,
  scroller: HTMLElement
): boolean {
  const box = element.getBoundingClientRect();
  const scrollerBox = scroller.getBoundingClientRect();
  return box.top < scrollerBox.top || box.bottom > scrollerBox.bottom;
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
 * The comparison's counts, then its changed Groups, steps, and connections,
 * read top to bottom. Each Group and step row opens in place to show its
 * differences. The list keeps its scroll for the address.
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
  const { objects, selectedKey } = useChangedObjects(payload);
  const select = useSelectChange();
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
  // Only the list scrolls, which keeps the position. Reveal stays mounted
  // while closed and slid off the canvas, where scrollIntoView could scroll an
  // ancestor sideways.
  const showRow = (header: HTMLElement) => {
    const box = scrollRef.current;
    if (box && isOutsideScroller(header, box)) {
      box.scrollBy({
        top:
          header.getBoundingClientRect().top - box.getBoundingClientRect().top,
      });
      adoptScroll();
    }
  };

  return (
    <>
      <ComparisonSummarySection payload={payload} status={status} />
      {objects.length === 0 ? (
        <StatusPlaceholder label={noChangesLabel(payload)} />
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          data-slot="change-list"
          onScroll={onScroll}
          onScrollEnd={onScrollEnd}
          ref={scrollRef}
        >
          <ChangeListSections
            layout="columns"
            objects={objects}
            onChoose={select}
            payload={payload}
            selectedKey={selectedKey}
            showRow={showRow}
          />
        </div>
      )}
    </>
  );
}

/** Scroll `header` into view in whichever boxes scroll it, the least they must. */
function scrollIntoNearestView(header: HTMLElement): void {
  header.scrollIntoView?.({ block: "nearest" });
}

/**
 * The change list's sections of changed Groups, steps, then connections, one
 * row per object. A Group or step row opens in place to show its differences
 * in `layout`, and a connection row is a single control. Pressing an object's
 * name calls `onChoose`, which selects it on the canvas, and its row shows as
 * pressed while `selectedKey` names it.
 *
 * The selected object's row opens whenever the list shows a selection it has
 * not revealed yet, whether the selection changed on the canvas, from a Group
 * card's count, or by a name, and whether the list was showing or mounts with
 * it. `showRow` then brings the row's header into view; without it the header
 * scrolls into view in whichever box scrolls it, such as a phone's sheet. A
 * list that mounts with the selection it last revealed, such as after version
 * history, keeps its open rows and restored scroll. Clearing the selection
 * forgets it, so selecting the same object again opens its row again.
 */
export function ChangeListSections({
  payload,
  objects,
  selectedKey,
  onChoose,
  layout,
  showRow = scrollIntoNearestView,
}: {
  payload: WorkflowComparisonPayload;
  objects: readonly ChangedObject[];
  selectedKey: string | null;
  onChoose: ChooseChange;
  layout: ComparisonLayout;
  showRow?: ((header: HTMLElement) => void) | undefined;
}) {
  const rows = useOpenChangeRows(payload, objects);
  const headers = useRef(new Map<string, HTMLElement>());
  useAfterCommit(selectedKey, () => {
    const item =
      objects.find((candidate) => candidate.key === selectedKey) ?? null;
    if ((item?.key ?? null) === rows.revealed) {
      return;
    }
    rows.reveal(item);
    const header = item ? headers.current.get(item.key) : undefined;
    if (header) {
      showRow(header);
    }
  });

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
      <ul className="divide-y">
        {section.items.map((item) => (
          <ChangeRow
            headerRef={(element) => {
              if (element) {
                headers.current.set(item.key, element);
              } else {
                headers.current.delete(item.key);
              }
            }}
            item={item}
            key={item.key}
            layout={layout}
            objects={objects}
            onChoose={onChoose}
            onToggle={() => rows.toggle(item.key)}
            open={rows.open.has(item.key)}
            payload={payload}
            selected={item.key === selectedKey}
          />
        ))}
      </ul>
    </section>
  ));
}

/**
 * One row of the change list: the change marker, the object's name, and a
 * line saying what changed. A Group or step row is a disclosure. Its chevron
 * control covers the whole row header and opens or closes the differences
 * beneath it, and the name above it is a control of its own that selects the
 * object on the canvas. A connection row is one control that selects it.
 */
function ChangeRow({
  item,
  payload,
  objects,
  layout,
  open,
  selected,
  onToggle,
  onChoose,
  headerRef,
}: {
  item: ChangedObject;
  payload: WorkflowComparisonPayload;
  objects: readonly ChangedObject[];
  layout: ComparisonLayout;
  open: boolean;
  selected: boolean;
  onToggle: () => void;
  onChoose: ChooseChange;
  headerRef: (element: HTMLElement | null) => void;
}) {
  const id = useId();
  const nameId = `${id}-name`;
  const summaryId = `${id}-summary`;
  const panelId = `${id}-differences`;
  const marker = (
    <ComparisonMarker
      className="static mt-px shrink-0"
      comparison={{ kind: item.change }}
    />
  );
  // A phone's row reads at body size, and Browse's at caption size.
  const name = "font-medium text-sm md:text-xs";
  const summary = (
    <p
      className="text-muted-foreground text-xs"
      data-slot="change-summary"
      id={summaryId}
    >
      {item.summary}
    </p>
  );
  if (!opensInPlace(item)) {
    return (
      <li data-change={item.change} data-slot="change-row">
        <button
          aria-pressed={selected}
          className={cn(
            "flex w-full items-start gap-2 px-4 py-2.5 text-left hover:bg-muted",
            selected && "bg-muted"
          )}
          onClick={() => onChoose(item)}
          ref={headerRef}
          type="button"
        >
          {/* Keeps the marker in line with the disclosure rows' markers. */}
          <span aria-hidden className="size-4 shrink-0" />
          {marker}
          <span className="min-w-0 flex-1">
            <span
              className={cn("block truncate", name)}
              data-slot="change-title"
            >
              {item.title}
            </span>
            {summary}
          </span>
        </button>
      </li>
    );
  }
  return (
    <li data-change={item.change} data-open={open} data-slot="change-row">
      <div
        className={cn(
          "relative flex items-start gap-2 px-4 py-2.5 hover:bg-muted",
          selected && "bg-muted"
        )}
        ref={headerRef}
      >
        {/* The chevron's ::after spans the header, so a press anywhere on the
            row toggles it. The name sits above that layer. */}
        <button
          aria-controls={open ? panelId : undefined}
          aria-expanded={open}
          aria-labelledby={`${nameId} ${summaryId}`}
          className="mt-px flex size-4 shrink-0 items-center justify-center text-muted-foreground outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:outline-ring focus-visible:after:-outline-offset-2"
          onClick={onToggle}
          type="button"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-4 transition-transform duration-150 motion-reduce:transition-none",
              open && "rotate-90"
            )}
          />
        </button>
        {marker}
        <div className="min-w-0 flex-1">
          <button
            aria-pressed={selected}
            className={cn(
              "relative z-10 block max-w-full truncate rounded-sm text-left underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring",
              name
            )}
            data-slot="change-title"
            id={nameId}
            onClick={() => onChoose(item)}
            title="Show on the canvas"
            type="button"
          >
            {item.title}
          </button>
          {summary}
        </div>
      </div>
      {open ? (
        <div
          aria-labelledby={nameId}
          className="border-t bg-card pb-1"
          data-slot="change-differences"
          id={panelId}
          role="region"
        >
          <ChangeDifferences
            key={comparisonIdentity(payload)}
            layout={layout}
            object={item.object}
            objects={objects}
            onSelect={onChoose}
            payload={payload}
          />
        </div>
      ) : null}
    </li>
  );
}
