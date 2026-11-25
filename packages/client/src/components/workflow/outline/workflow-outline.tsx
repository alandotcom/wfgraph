import { useAtomValue, useSetAtom, useStore } from "jotai";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  EyeOff,
  Group,
  Play,
  Zap,
} from "lucide-react";
import {
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  useMemo,
  useRef,
  useState,
} from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { ComparisonMarker } from "#src/components/flow-elements/comparison-marker";
import { NodeIssueBadge } from "#src/components/flow-elements/node-issue-badge";
import { revealTitleFocusRequestAtom } from "#src/components/workflow/canvas-reveal/reveal-requests";
import { ProviderLogo } from "#src/components/workflow/nodes/action-node";
import { useFocusWorkflowNode } from "#src/components/workflow/use-focus-workflow-node";
import { Input } from "#src/components/ui/input";
import { useAfterCommit, useAfterPaint, useDomEvent } from "#src/hooks/effects";
import { showGraphEditRefusal } from "#src/components/workflow/graph-edit-refusal";
import { openCommandPaletteAtom } from "#src/lib/command-palette-store";
import { editorChordAllowed } from "#src/lib/editor-shortcuts";
import { inactiveBranch } from "#src/lib/inactive-branch";
import { editOfNode, workflowEdits } from "#src/lib/workflow-edits";
import {
  canvasSelectionAtom,
  edgesAtom,
  nodesAtom,
  presentedGraphAtom,
} from "#src/lib/workflow-graph-store";
import { canvasIssuesByNodeIdAtom } from "#src/lib/workflow-graph-presentation-store";
import {
  isReviewSheetShownAtom,
  requestReviewScrollAtom,
  reviewComparisonAtom,
  reviewHighlightAtom,
} from "#src/lib/workflow-review-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import {
  type OutlineRow,
  outlineRows,
  type WorkflowOutline as Outline,
  workflowOutline,
  workflowStepNumbers,
} from "@wfgraph/shared/graph/workflow-outline";
import { cn } from "@wfgraph/shared/utils";
import {
  ancestorKeys,
  foldableKeys,
  isFocusableRow,
  isNodeRow,
  moveFocus,
  type OutlineNodeRow,
  visibleRows,
} from "./outline-view";

/** Pixels each level of nesting indents a row. */
const INDENT_PX = 14;

/** The DOM id of an outline row, so another column can return focus to it. */
export function outlineRowElementId(key: string): string {
  return `workflow-outline-row-${encodeURIComponent(key)}`;
}

/** The step a row stands for: its own, or the one a reference leads to. */
function nodeIdOf(row: OutlineRow): string | null {
  if (isNodeRow(row)) return row.nodeId;
  return row.kind === "continues" ? row.targetNodeId : null;
}

type Section = { title: string; rows: readonly OutlineRow[] };

function outlineSections(outline: Outline): Section[] {
  return [
    { title: "Starts when", rows: outline.starts },
    { title: "Steps", rows: outline.steps },
    { title: "Stops when", rows: outline.stops },
    { title: "Not connected", rows: outline.unconnected },
  ].filter((section) => section.rows.length > 0);
}

/**
 * The workflow in run order, one row per step, for the editor's left column.
 * It reads the graph the active workspace presents, the canvas selection and
 * the extension catalog from the editor's stores, so it takes no props. It
 * fills its container and scrolls inside it. The list is one Tab stop: arrow
 * keys, Home and End move between rows and select each step, Left and Right
 * fold, Enter selects the step and asks the details for focus, and `/` opens
 * the step picker to add a step after the row's step. Pointing at
 * or focusing a row puts the selection halo on its card without moving the
 * camera. Cmd+F or Ctrl+F focuses the filter field.
 */
export function WorkflowOutline() {
  const catalog = useExtensionCatalog();
  const store = useStore();
  const graph = useAtomValue(presentedGraphAtom);
  const draftNodes = useAtomValue(nodesAtom);
  const draftEdges = useAtomValue(edgesAtom);
  const view = useAtomValue(workflowWorkspaceViewAtom);
  const reviewShown = useAtomValue(isReviewSheetShownAtom);
  const comparison = useAtomValue(reviewComparisonAtom);
  const selection = useAtomValue(canvasSelectionAtom);
  const issuesByNode = useAtomValue(canvasIssuesByNodeIdAtom);
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const focusNode = useFocusWorkflowNode();
  const setHighlight = useSetAtom(reviewHighlightAtom);
  const requestReviewScroll = useSetAtom(requestReviewScrollAtom);
  const focusRevealTitle = useSetAtom(revealTitleFocusRequestAtom);
  const openPalette = useSetAtom(openCommandPaletteAtom);

  const editing = view === "draft" && !reviewShown;
  // While the review sheet shows, the graph holds removed steps too, and the
  // rows keep the draft's numbers so they match the cards.
  const draftNumbers = useMemo(
    () =>
      reviewShown
        ? workflowStepNumbers({
            nodes: draftNodes,
            edges: draftEdges,
            catalog,
          })
        : undefined,
    [reviewShown, draftNodes, draftEdges, catalog]
  );
  const outline = useMemo(
    () =>
      graph
        ? workflowOutline({
            nodes: graph.nodes,
            edges: graph.edges,
            catalog,
            numberOf: draftNumbers,
          })
        : null,
    [graph, catalog, draftNumbers]
  );
  const rows = useMemo(() => (outline ? outlineRows(outline) : []), [outline]);
  const unreachable = useMemo(
    () => (editing && graph ? inactiveBranch(graph).nodeIds : new Set()),
    [editing, graph]
  );
  const edits =
    reviewShown && comparison ? workflowEdits(comparison, catalog) : null;

  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const treeRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const selectedIds = reviewShown ? [] : selection.nodeIds;
  const selectedKey =
    rows.find((row) => isNodeRow(row) && selectedIds.includes(row.nodeId))
      ?.key ?? null;

  // A step selected anywhere else opens the sections it sits in and takes
  // the keyboard's place in the list.
  const [seenSelectedKey, setSeenSelectedKey] = useState(selectedKey);
  if (selectedKey !== seenSelectedKey) {
    setSeenSelectedKey(selectedKey);
    if (selectedKey !== null) {
      setFocusedKey(selectedKey);
      const above = ancestorKeys(rows, selectedKey);
      if (above.some((key) => folded.has(key))) {
        setFolded(new Set([...folded].filter((key) => !above.includes(key))));
      }
    }
  }

  const shown = visibleRows(rows, { folded, filter });
  const shownKeys = new Set(shown.map((row) => row.key));
  const canFold = foldableKeys(rows);
  const activeKey =
    (focusedKey !== null && shownKeys.has(focusedKey) && focusedKey) ||
    (selectedKey !== null && shownKeys.has(selectedKey) && selectedKey) ||
    (shown.find(isFocusableRow)?.key ?? null);

  const rowElement = (key: string) =>
    treeRef.current?.querySelector<HTMLElement>(
      `#${CSS.escape(outlineRowElementId(key))}`
    ) ?? null;

  useAfterPaint(selectedKey, () => {
    if (selectedKey !== null) {
      rowElement(selectedKey)?.scrollIntoView?.({ block: "nearest" });
    }
  });
  useAfterCommit(focusRequest, () => {
    if (focusRequest > 0 && activeKey !== null) {
      rowElement(activeKey)?.focus();
    }
  });

  useDomEvent(document, "keydown", (event) => {
    if (
      event.key.toLowerCase() === "f" &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      editorChordAllowed(event, { inTextFields: true })
    ) {
      event.preventDefault();
      filterRef.current?.focus();
      filterRef.current?.select();
    }
  });

  const focusRow = (key: string) => {
    setFocusedKey(key);
    setFocusRequest((count) => count + 1);
  };

  /** Select the step a row stands for, as a press on its card would. */
  const choose = (row: OutlineRow) => {
    const nodeId = nodeIdOf(row);
    if (nodeId === null) return;
    if (row.kind === "continues") {
      const target = rows.find(
        (candidate) => isNodeRow(candidate) && candidate.nodeId === nodeId
      );
      if (target) {
        setFolded(
          new Set(
            [...folded].filter(
              (key) => !ancestorKeys(rows, target.key).includes(key)
            )
          )
        );
        focusRow(target.key);
      }
    }
    if (reviewShown) {
      // The canvas holds no selection while the sheet shows, so a changed
      // row scrolls the sheet to its edit, as a press on its card does.
      setHighlight(nodeId);
      if (edits && editOfNode(edits, nodeId)) requestReviewScroll(nodeId);
      return;
    }
    if (workflowId !== null) {
      focusNode({ nodeId, workflowId });
    }
  };

  const point = (row: OutlineRow) => {
    const nodeId = nodeIdOf(row);
    if (nodeId !== null) setHighlight(nodeId);
  };
  const stopPointing = (row: OutlineRow) => {
    const nodeId = nodeIdOf(row);
    if (nodeId !== null && store.get(reviewHighlightAtom) === nodeId) {
      setHighlight(null);
    }
  };

  const toggleFold = (key: string) => {
    setFolded(
      folded.has(key)
        ? new Set([...folded].filter((item) => item !== key))
        : new Set([...folded, key])
    );
  };

  const moveTo = (key: string | null) => {
    if (key === null) return;
    const row = shown.find((candidate) => candidate.key === key);
    focusRow(key);
    if (row && row.kind !== "continues") choose(row);
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (activeKey === null || event.metaKey || event.ctrlKey) return;
    const row = shown.find((candidate) => candidate.key === activeKey);
    if (!row) return;
    const isOpen = canFold.has(row.key) && !folded.has(row.key);
    const handled = (() => {
      switch (event.key) {
        case "ArrowDown":
        case "ArrowUp":
        case "Home":
        case "End":
          if (event.altKey) return false;
          moveTo(moveFocus({ shown, from: row.key, key: event.key }));
          return true;
        case "ArrowLeft":
          if (isOpen && filter === "") {
            toggleFold(row.key);
          } else {
            moveTo(moveFocus({ shown, from: row.key, key: "parent" }));
          }
          return true;
        case "ArrowRight":
          if (canFold.has(row.key) && folded.has(row.key)) {
            toggleFold(row.key);
          } else if (isOpen) {
            moveTo(moveFocus({ shown, from: row.key, key: "child" }));
          }
          return true;
        case "Enter": {
          choose(row);
          const nodeId = nodeIdOf(row);
          if (!reviewShown && nodeId !== null) focusRevealTitle(nodeId);
          return true;
        }
        case " ":
          choose(row);
          return true;
        case "/":
          if (event.altKey || event.shiftKey) return false;
          addStepAfter(row);
          return true;
        default:
          return false;
      }
    })();
    if (handled) event.preventDefault();
  };

  /**
   * Open the command palette's step picker to add a step after the row's step.
   * The picker adds on the selected step's one outlet, so the row is selected
   * first. A Condition and an Event Split have several outlets and a Group has
   * none of its own, so those rows say where to add instead.
   */
  const addStepAfter = (row: OutlineRow) => {
    if (!editing) return;
    if (
      row.kind === "group" ||
      row.kind === "continues" ||
      (row.kind === "step" &&
        (row.stepKind === "condition" || row.stepKind === "event-split"))
    ) {
      showGraphEditRefusal({
        refusal:
          row.kind === "group"
            ? "Select a step inside the Group to add a step after it."
            : row.kind === "continues"
              ? "Select the step to add a step after it."
              : "Add a step on one of its outlets from the canvas.",
      });
      return;
    }
    if (row.key !== selectedKey) choose(row);
    openPalette({ id: "add-step" });
  };

  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && filter !== "") {
      event.preventDefault();
      setFilter("");
    } else if (
      (event.key === "Escape" || event.key === "ArrowDown") &&
      activeKey !== null
    ) {
      event.preventDefault();
      focusRow(activeKey);
    }
  };

  const sections = outline ? outlineSections(outline) : [];
  const shownSections = sections
    .map((section) => ({
      ...section,
      rows: section.rows.filter((row) => shownKeys.has(row.key)),
    }))
    .filter((section) => section.rows.length > 0);

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col"
      data-slot="workflow-outline"
    >
      <div className="shrink-0 border-b px-2 py-2">
        <Input
          aria-keyshortcuts="Meta+F Control+F"
          aria-label="Filter steps"
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={onFilterKeyDown}
          placeholder="Filter steps"
          ref={filterRef}
          type="search"
          value={filter}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {graph === null ? (
          <p className="px-3 py-3 text-muted-foreground text-sm">
            Open a run to see what it did at each step.
          </p>
        ) : shownSections.length === 0 ? (
          <p className="px-3 py-3 text-muted-foreground text-sm">
            {filter.trim() === ""
              ? "This workflow has no steps yet."
              : "No step matches the filter."}
          </p>
        ) : (
          <div
            aria-label="Outline"
            onKeyDown={onTreeKeyDown}
            ref={treeRef}
            role="tree"
          >
            {shownSections.map((section) => (
              <div key={section.title} role="none">
                <div
                  className="px-3 pt-3 pb-1 font-medium text-muted-foreground text-xs"
                  role="none"
                >
                  {section.title}
                </div>
                {section.rows.map((row) => (
                  <OutlineRowView
                    active={row.key === activeKey}
                    edit={
                      edits && isNodeRow(row)
                        ? (editOfNode(edits, row.nodeId) ?? null)
                        : null
                    }
                    expanded={
                      canFold.has(row.key)
                        ? !folded.has(row.key) || filter !== ""
                        : undefined
                    }
                    issues={
                      editing && isNodeRow(row)
                        ? issuesByNode.get(row.nodeId)
                        : undefined
                    }
                    key={row.key}
                    muted={isNodeRow(row) && unreachable.has(row.nodeId)}
                    onChoose={() => {
                      focusRow(row.key);
                      choose(row);
                    }}
                    onFocus={() => {
                      setFocusedKey(row.key);
                      point(row);
                    }}
                    onLeave={() => stopPointing(row)}
                    onPoint={() => point(row)}
                    onToggle={() => toggleFold(row.key)}
                    row={row}
                    selected={row.key === selectedKey}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function OutlineRowView({
  row,
  active,
  selected,
  expanded,
  muted,
  issues,
  edit,
  onChoose,
  onFocus,
  onLeave,
  onPoint,
  onToggle,
}: {
  row: OutlineRow;
  /** Whether the row holds the list's one Tab stop. */
  active: boolean;
  selected: boolean;
  /** Undefined for a row with nothing under it. */
  expanded: boolean | undefined;
  /** Whether no run can reach the step, as the canvas mutes its card. */
  muted: boolean;
  issues: Parameters<typeof NodeIssueBadge>[0]["issues"];
  edit: { kind: "added" | "modified" | "removed" } | null;
  onChoose: () => void;
  onFocus: () => void;
  onLeave: () => void;
  onPoint: () => void;
  onToggle: () => void;
}) {
  const indent = { paddingLeft: 4 + INDENT_PX * row.depth };
  const chevron =
    expanded === undefined ? (
      <span className="size-4 shrink-0" />
    ) : (
      <button
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted"
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        tabIndex={-1}
        type="button"
      >
        {expanded ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
      </button>
    );

  if (row.kind === "outlet" || row.kind === "parallel") {
    // A heading over the rows behind an outlet or an arm. Pressing it folds
    // that block; the keyboard folds from the step that opens it.
    const folded = expanded === false;
    return (
      <div
        className="flex h-6 cursor-default items-center gap-1 pr-2 text-muted-foreground text-xs"
        onClick={expanded === undefined ? undefined : onToggle}
        role="none"
        style={indent}
      >
        {chevron}
        <span className="ml-7 min-w-0 truncate font-medium">
          {row.text}
          {row.kind === "outlet" && row.detail ? ` · ${row.detail}` : ""}
          {folded ? ` · ${stepsNoun(row.stepCount)}` : ""}
        </span>
      </div>
    );
  }

  const focusHandlers = {
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) onLeave();
    },
    onFocus,
  };

  if (row.kind === "continues") {
    return (
      <div
        aria-level={row.depth + 1}
        className={cn(
          "flex h-7 cursor-default items-center gap-1 pr-2 text-muted-foreground text-sm outline-none",
          "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        )}
        id={outlineRowElementId(row.key)}
        onClick={onChoose}
        onPointerEnter={onPoint}
        onPointerLeave={onLeave}
        role="treeitem"
        style={indent}
        tabIndex={active ? 0 : -1}
        {...focusHandlers}
      >
        <span className="size-4 shrink-0" />
        <span className="w-6 shrink-0" />
        <CornerDownRight aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{row.text}</span>
      </div>
    );
  }

  const nodeRow: OutlineNodeRow = row;
  return (
    <div
      aria-expanded={expanded}
      aria-level={row.depth + 1}
      aria-selected={selected}
      className={cn(
        "flex h-7 cursor-default items-center gap-1 pr-2 text-sm outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted",
        muted && "opacity-60"
      )}
      data-node-id={nodeRow.nodeId}
      id={outlineRowElementId(row.key)}
      onClick={onChoose}
      onPointerEnter={onPoint}
      onPointerLeave={onLeave}
      role="treeitem"
      style={indent}
      tabIndex={active ? 0 : -1}
      {...focusHandlers}
    >
      {chevron}
      <span className="w-6 shrink-0 text-right text-muted-foreground text-xs tabular-nums">
        {nodeRow.kind === "step" ? (nodeRow.number ?? "") : ""}
      </span>
      <span aria-hidden className="ml-1 flex size-4 shrink-0 items-center">
        <RowGlyph row={nodeRow} />
      </span>
      <span className="ml-1 min-w-0 flex-1 truncate">
        <span className="font-medium">{nodeRow.label}</span>
        {nodeRow.summary ? (
          <span className="text-muted-foreground"> · {nodeRow.summary}</span>
        ) : null}
      </span>
      <RowEnd>
        {nodeRow.kind === "step" && nodeRow.disabled ? (
          <span className="flex items-center text-muted-foreground">
            <EyeOff aria-hidden className="size-3.5" />
            <span className="sr-only">Disabled</span>
          </span>
        ) : null}
        {issues ? <NodeIssueBadge issues={issues} placement="inline" /> : null}
        {edit ? (
          <ComparisonMarker className="static shrink-0" comparison={edit} />
        ) : null}
      </RowEnd>
    </div>
  );
}

function RowEnd({ children }: { children: ReactNode }) {
  return <span className="flex shrink-0 items-center gap-1">{children}</span>;
}

/** The glyph a row's card leads with on the canvas. */
function RowGlyph({ row }: { row: OutlineNodeRow }) {
  const catalog = useExtensionCatalog();
  if (row.kind === "lifecycle") {
    return <Play className="size-4 text-node-lifecycle" strokeWidth={1.5} />;
  }
  if (row.kind === "group") {
    return <Group className="size-4 text-muted-foreground" strokeWidth={1.5} />;
  }
  if (row.actionType === undefined) {
    return <Zap className="size-4 text-muted-foreground" strokeWidth={1.5} />;
  }
  return (
    <ProviderLogo
      actionType={row.actionType}
      catalog={catalog}
      className="size-4"
    />
  );
}

function stepsNoun(count: number): string {
  return count === 1 ? "1 step" : `${count} steps`;
}
