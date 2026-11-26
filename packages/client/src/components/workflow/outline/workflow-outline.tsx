import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import {
  ChevronDown,
  ChevronRight,
  CircleX,
  Clock,
  CornerDownRight,
  EyeOff,
  Group,
  Play,
  Plus,
  Zap,
} from "lucide-react";
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useMemo,
  useRef,
  useState,
} from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { ComparisonMarker } from "#src/components/flow-elements/comparison-marker";
import { NodeIssueBadge } from "#src/components/flow-elements/node-issue-badge";
import { editFocusTarget } from "#src/components/workflow/canvas-reveal/reveal-edit-target";
import { requestRevealEditFocusAtom } from "#src/components/workflow/canvas-reveal/reveal-requests";
import { ProviderLogo } from "#src/components/workflow/nodes/action-node";
import { runEvidenceOriginAtom } from "#src/components/workflow/run-evidence-origin";
import { useFocusWorkflowNode } from "#src/components/workflow/use-focus-workflow-node";
import { useInspectRunNode } from "#src/components/workflow/use-run-node-evidence";
import { requestRevealPlacementAtom } from "#src/components/workflow/canvas-reveal/reveal-requests";
import { useTopologyAuthoring } from "#src/components/workflow/canvas-interaction";
import { contextMenuAtom } from "#src/components/workflow/workflow-context-menu";
import { scrollIntoScroller } from "#src/lib/scroll-into-scroller";
import { can } from "#src/lib/authorization";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { workspaceAddressId } from "#src/lib/workflow-navigation-state";
import { expandGroupAtom } from "#src/lib/collapsed-groups";
import {
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
} from "#src/lib/workflow-workspace-navigation";
import { Input } from "#src/components/ui/input";
import {
  detailsFloatOpenAtom,
  outlineFilterFocusRequestAtom,
} from "#src/components/workflow/columns/editor-columns-store";
import { useIsMobile } from "#src/hooks/use-mobile";
import { useAfterCommit, useAfterPaint, useDomEvent } from "#src/hooks/effects";
import { eventLabel } from "@wfgraph/shared/graph/workflow-summary";
import { isRunInProgress } from "#src/lib/execution-logs";
import { showGraphEditRefusal } from "#src/components/workflow/graph-edit-refusal";
import { openCommandPaletteAtom } from "#src/lib/command-palette-store";
import { editorChordAllowed } from "#src/lib/editor-shortcuts";
import { inactiveBranch } from "#src/lib/inactive-branch";
import { editOfNode, workflowEdits } from "#src/lib/workflow-edits";
import {
  canvasEditingLockedAtom,
  canvasSelectionAtom,
  edgesAtom,
  executionOverlayGraphAtom,
  moveStepAtom,
  nodesAtom,
  presentedGraphAtom,
  runNodeEvidenceStatusesAtom,
  runPathAtom,
} from "#src/lib/workflow-graph-store";
import {
  canvasIssuesByNodeIdAtom,
  projectedRunLogsAtom,
} from "#src/lib/workflow-graph-presentation-store";
import {
  isReviewSheetShownAtom,
  requestReviewScrollAtom,
  reviewComparisonAtom,
  reviewHighlightAtom,
} from "#src/lib/workflow-review-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import {
  outlineRows,
  type WorkflowOutline as Outline,
  workflowOutline,
  workflowStepNumbers,
} from "@wfgraph/shared/graph/workflow-outline";
import { cn } from "@wfgraph/shared/utils";
import { type RunOutcome, runOutline } from "./outline-run";
import {
  ancestorKeys,
  foldableKeys,
  isFocusableRow,
  isNodeRow,
  moveFocus,
  type OutlineAddRow,
  type OutlineDisplayRow,
  type OutlineNodeRow,
  visibleRows,
  withAddStepRows,
} from "./outline-view";

/** The open run's facts a row's outcome reads beyond its path and logs. */
export type OpenRunFacts = {
  waits: readonly {
    nodeId: string;
    subscribedEvents: readonly string[];
    waitUntil: Date | null;
  }[];
  testSkipped: ReadonlySet<string>;
};

const NO_WAITS: OpenRunFacts["waits"] = [];
const NO_NODE_IDS: ReadonlySet<string> = new Set();

/** Pixels each level of nesting indents a row. */
const INDENT_PX = 14;

/** The DOM id of an outline row, so another column can return focus to it. */
export function outlineRowElementId(key: string): string {
  return `workflow-outline-row-${encodeURIComponent(key)}`;
}

/** The step a row stands for: its own, or the one a reference leads to. */
function nodeIdOf(row: OutlineDisplayRow): string | null {
  if (isNodeRow(row)) return row.nodeId;
  return row.kind === "continues" ? row.targetNodeId : null;
}

type Section = { title: string; rows: readonly OutlineDisplayRow[] };

/**
 * The shown rows under their section titles. A run's outline reads what
 * starts it and its steps as one account under "What happened".
 */
function outlineSections(input: {
  outline: Outline;
  shown: readonly OutlineDisplayRow[];
  isRun: boolean;
}): Section[] {
  const { outline, isRun } = input;
  const parts = [
    { title: isRun ? "What happened" : "Starts when", rows: outline.starts },
    { title: isRun ? "What happened" : "Steps", rows: outline.steps },
    { title: "Stops when", rows: outline.stops },
    { title: "Not connected", rows: outline.unconnected },
  ];
  const titleOf = new Map(
    parts.flatMap((part) => part.rows.map((row) => [row.key, part.title]))
  );
  const sections: Section[] = [];
  for (const row of input.shown) {
    const title =
      titleOf.get(
        row.kind === "note" || row.kind === "add" ? row.standsFor : row.key
      ) ?? "Steps";
    const last = sections.at(-1);
    if (last?.title === title) {
      sections[sections.length - 1] = { title, rows: [...last.rows, row] };
    } else {
      sections.push({ title, rows: [row] });
    }
  }
  return sections;
}

/**
 * The workflow in run order, one row per step, floating over the canvas.
 * It reads the graph the active workspace presents, the canvas selection and
 * the extension catalog from the editor's stores, so it takes no props. It
 * fills its container and scrolls inside it. The list is one Tab stop: arrow
 * keys, Home and End move between rows and select each step, Left and Right
 * fold, Enter selects the step and asks the details for focus, and `/` opens
 * the step picker to add a step after the row's step, and Alt+Up and Alt+Down
 * move the step within its sequence. Pointing at
 * or focusing a row puts the pointed tint on its card without moving the
 * camera. Cmd+F or Ctrl+F shows the filter field at the top of the list and
 * focuses it; Escape, or leaving it empty, hides it again.
 */
export function WorkflowOutline({
  openRun,
}: {
  /**
   * What the Runs column already reads about the open run that the outline's
   * rows say: the Waits it is parked on and the steps a test run skipped.
   */
  openRun?: OpenRunFacts | undefined;
} = {}) {
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
  const inspectRunNode = useInspectRunNode();
  const requestPlacement = useSetAtom(requestRevealPlacementAtom);
  const setHighlight = useSetAtom(reviewHighlightAtom);
  const requestReviewScroll = useSetAtom(requestReviewScrollAtom);
  const requestEditFocus = useSetAtom(requestRevealEditFocusAtom);
  const openPalette = useSetAtom(openCommandPaletteAtom);
  const applyMoveStep = useSetAtom(moveStepAtom);
  const runPath = useAtomValue(runPathAtom);
  const runStatuses = useAtomValue(runNodeEvidenceStatusesAtom);
  const runLogs = useAtomValue(projectedRunLogsAtom);
  const runWaits = openRun?.waits ?? NO_WAITS;
  const testSkipped = openRun?.testSkipped ?? NO_NODE_IDS;

  const editing = view === "draft" && !reviewShown;
  const locked = useAtomValue(canvasEditingLockedAtom);
  const topologyAuthoring = useTopologyAuthoring();
  const setContextMenu = useSetAtom(contextMenuAtom);
  // Whether a row answers right-click, Shift-click and Cmd-click the way its
  // canvas card does: in an editable Draft, where the canvas offers them.
  const authoring =
    editing &&
    !locked &&
    topologyAuthoring &&
    can(WfGraphOperations.workflowUpdate.id);
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
  const outlineRowList = useMemo(
    () => (outline ? outlineRows(outline) : []),
    [outline]
  );
  // On a run, what the run did at each step, with the branches it did not
  // take folded.
  const run = useMemo(
    () =>
      view === "runs" && runPath !== null && runLogs !== null
        ? runOutline({
            rows: outlineRowList,
            path: runPath,
            statuses: runStatuses,
            logs: runLogs.logs,
            testSkipped,
            waits: runWaits,
            eventLabel: (name) => eventLabel(catalog, name),
            ended: !isRunInProgress(runLogs.executionStatus),
          })
        : null,
    [
      view,
      runPath,
      runLogs,
      runStatuses,
      testSkipped,
      runWaits,
      catalog,
      outlineRowList,
    ]
  );
  // The draft's outline offers a step at every open end of a path.
  const draftRows = useMemo(
    () =>
      editing && graph
        ? withAddStepRows({ rows: outlineRowList, edges: graph.edges })
        : outlineRowList,
    [editing, graph, outlineRowList]
  );
  const rows: readonly OutlineDisplayRow[] = run?.rows ?? draftRows;
  const unreachable = useMemo(
    () => (editing && graph ? inactiveBranch(graph).nodeIds : new Set()),
    [editing, graph]
  );
  const edits =
    reviewShown && comparison ? workflowEdits(comparison, catalog) : null;

  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");
  // The filter field shows only while it is in use, except on a phone, where
  // the outline is the screen and keeps its field at the top.
  const isMobile = useIsMobile();
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterRequested, setFilterRequested] = useAtom(
    outlineFilterFocusRequestAtom
  );
  const filterShown = isMobile || filterOpen || filterRequested;
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const treeRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
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

  // The selected row scrolls into view inside the list alone. Every focus move
  // passes `preventScroll`, so nothing outside the list ever scrolls to a row.
  useAfterPaint(selectedKey, () => {
    const row = selectedKey === null ? null : rowElement(selectedKey);
    if (row && scrollerRef.current) {
      scrollIntoScroller(scrollerRef.current, row);
    }
  });
  useAfterCommit(focusRequest, () => {
    if (focusRequest > 0 && activeKey !== null) {
      rowElement(activeKey)?.focus({ preventScroll: true });
    }
  });

  // Cmd+F and "Find a step" show the filter field in place at the top of the
  // list, and the cursor goes into it once it has rendered.
  useAfterCommit(filterRequested, () => {
    if (!filterRequested) return;
    setFilterRequested(false);
    setFilterOpen(true);
    filterRef.current?.focus({ preventScroll: true });
    filterRef.current?.select();
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
      setFilterRequested(true);
    }
  });

  const focusRow = (key: string) => {
    setFocusedKey(key);
    setFocusRequest((count) => count + 1);
  };

  /** Select the step a row stands for, as a press on its card would. */
  const choose = (row: OutlineDisplayRow) => {
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
    // Pressing a row opens the Inspector again after its X or Escape closed
    // it with the step still selected.
    store.set(detailsFloatOpenAtom, true);
    if (view === "runs") {
      // On a run the row shows the step's evidence on the one canvas, and
      // Back and Escape return to the row. A step in a Group the viewer
      // collapsed draws its Group in place again.
      inspectRunNode({ nodeId, logId: null });
      const origin = store.get(runEvidenceOriginAtom);
      if (origin?.nodeId === nodeId) {
        store.set(runEvidenceOriginAtom, { ...origin, fromOutline: true });
      }
      const parentId = store
        .get(executionOverlayGraphAtom)
        ?.nodes.find((node) => node.id === nodeId)?.parentId;
      if (parentId !== undefined) {
        store.set(expandGroupAtom, parentId);
      }
      requestPlacement({
        addressId: workspaceAddressId(store.get(activeWorkspaceAddressAtom)),
        nodeIds: [nodeId],
      });
      return;
    }
    if (workflowId !== null) {
      focusNode({ nodeId, workflowId });
    }
  };

  /**
   * Shift-click adds the row's step to the selection and Cmd-click or
   * Ctrl-click adds or removes it, as on the canvas. Answers whether the
   * click was one of those.
   */
  const extendSelection = (row: OutlineDisplayRow, event: MouseEvent) => {
    if (
      !(authoring && isNodeRow(row)) ||
      !(event.shiftKey || event.metaKey || event.ctrlKey)
    ) {
      return false;
    }
    const current = store.get(activeSelectionAtom).nodeIds;
    const holds = current.includes(row.nodeId);
    const nodeIds =
      holds && !event.shiftKey
        ? current.filter((id) => id !== row.nodeId)
        : holds
          ? current
          : [...current, row.nodeId];
    store.set(activeSelectionAtom, { nodeIds, edgeIds: [] });
    return true;
  };

  /**
   * Right-click opens the step's context menu, the one its canvas card opens.
   * A row outside the selection becomes the selection first; a row inside it
   * keeps the selection, so the menu offers the commands for all of it.
   */
  const openRowMenu = (row: OutlineDisplayRow, event: MouseEvent) => {
    if (!(authoring && isNodeRow(row))) return;
    event.preventDefault();
    const current = store.get(activeSelectionAtom).nodeIds;
    const keeps = current.includes(row.nodeId);
    if (!keeps) {
      store.set(activeSelectionAtom, { nodeIds: [row.nodeId], edgeIds: [] });
    }
    setContextMenu({
      type: "node",
      position: { x: event.clientX, y: event.clientY },
      nodeId: row.nodeId,
      selectedIds: new Set(keeps ? current : [row.nodeId]),
    });
  };

  const point = (row: OutlineDisplayRow) => {
    const nodeId = nodeIdOf(row);
    if (nodeId !== null) setHighlight(nodeId);
  };
  const stopPointing = (row: OutlineDisplayRow) => {
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
      if (
        row.kind === "add" &&
        (event.key === "Enter" || event.key === " " || event.key === "/")
      ) {
        addStepAt(row);
        return true;
      }
      switch (event.key) {
        case "ArrowDown":
        case "ArrowUp":
          if (event.altKey) {
            moveStep(row, event.key === "ArrowUp" ? "up" : "down");
            return true;
          }
          moveTo(moveFocus({ shown, from: row.key, key: event.key }));
          return true;
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
          const node = draftNodes.find((item) => item.id === nodeId);
          if (!reviewShown && node !== undefined) {
            requestEditFocus({
              nodeId: node.id,
              targetId: editFocusTarget(node),
            });
          }
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

  /** Open the step picker `/` opens, to add a step on the row's open outlet. */
  const addStepAt = (row: OutlineAddRow) => {
    if (!editing) return;
    openPalette({ id: "add-step", after: row.source });
  };

  /**
   * Open the command palette's step picker to add a step after the row's step.
   * The picker adds on the selected step's one outlet, so the row is selected
   * first. A Condition and an Event Split have several outlets and a Group has
   * none of its own, so those rows say where to add instead.
   */
  const addStepAfter = (row: OutlineDisplayRow) => {
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

  /**
   * Swap the row's step with the one before or after it in its sequence, as
   * Alt+Up and Alt+Down do. The row keeps focus, and the outline redraws in
   * the new order.
   */
  const moveStep = (row: OutlineDisplayRow, direction: "up" | "down") => {
    if (!editing) return;
    if (row.kind !== "step") {
      showGraphEditRefusal({ refusal: "Select a step to move it." });
      return;
    }
    showGraphEditRefusal(applyMoveStep({ nodeId: row.nodeId, direction }));
  };

  // Escape clears the filter, hides the field and returns to the rows. Down
  // moves to the rows and keeps the filter.
  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setFilter("");
      setFilterOpen(false);
      if (activeKey !== null) focusRow(activeKey);
    } else if (event.key === "ArrowDown" && activeKey !== null) {
      event.preventDefault();
      focusRow(activeKey);
    }
  };

  // A run's rows name a time only where it differs from the row before.
  const timedRowKeys = new Set<string>();
  let lastTime: string | null = null;
  for (const row of shown) {
    const time = run?.outcomes.get(row.key)?.time ?? null;
    if (time !== null && time !== lastTime) timedRowKeys.add(row.key);
    if (time !== null) lastTime = time;
  }

  const shownSections = outline
    ? outlineSections({ outline, shown, isRun: run !== null })
    : [];

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col"
      data-slot="workflow-outline"
    >
      {filterShown ? (
        <div className="shrink-0 px-1.5 pt-1 pb-1">
          <Input
            aria-keyshortcuts="Meta+F Control+F"
            aria-label="Filter steps"
            // Leaving an empty field hides it again.
            onBlur={() => {
              if (filter === "") setFilterOpen(false);
            }}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={onFilterKeyDown}
            placeholder="Filter steps"
            ref={filterRef}
            type="search"
            value={filter}
          />
        </div>
      ) : null}
      <div
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-1 pb-3"
        ref={scrollerRef}
      >
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
            aria-multiselectable={authoring}
            onKeyDown={onTreeKeyDown}
            ref={treeRef}
            role="tree"
          >
            {shownSections.map((section) => (
              <div key={section.title} role="none">
                <div
                  className="px-2 pt-2.5 pb-0.5 text-muted-foreground text-xs"
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
                    muted={
                      isNodeRow(row) &&
                      (unreachable.has(row.nodeId) ||
                        run?.outcomes
                          .get(row.key)
                          ?.text.startsWith("Not reached") === true)
                    }
                    outcome={run?.outcomes.get(row.key)}
                    showsTime={timedRowKeys.has(row.key)}
                    onChoose={(event) => {
                      focusRow(row.key);
                      if (extendSelection(row, event)) return;
                      if (row.kind === "add") {
                        addStepAt(row);
                      } else {
                        choose(row);
                      }
                    }}
                    onContextMenu={(event) => openRowMenu(row, event)}
                    onFocus={() => {
                      setFocusedKey(row.key);
                      point(row);
                    }}
                    onLeave={() => stopPointing(row)}
                    onPoint={() => point(row)}
                    onToggle={() => toggleFold(row.key)}
                    row={row}
                    selected={
                      isNodeRow(row) && selectedIds.includes(row.nodeId)
                    }
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

/** Pixels of the row's own left padding, before any nesting. */
const ROW_INSET_PX = 8;

/**
 * Pixels from a row's indent to its text: the number column, the glyph and
 * the gaps between them. An outlet label and a note start their text here,
 * so they line up with the labels of the rows under them.
 */
const TEXT_OFFSET_PX = 46;

function indentPx(depth: number): number {
  return ROW_INSET_PX + INDENT_PX * depth;
}

/**
 * The control that folds a Group or a block. It sits in space the row already
 * has, the Group's empty number slot or the gap before a label, so rows that
 * cannot fold carry no column for it. The keyboard folds with Left and Right.
 */
function FoldToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <span
      aria-hidden
      className="flex size-3 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {expanded ? (
        <ChevronDown className="size-3" />
      ) : (
        <ChevronRight className="size-3" />
      )}
    </span>
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
  outcome,
  showsTime,
  onChoose,
  onContextMenu,
  onFocus,
  onLeave,
  onPoint,
  onToggle,
}: {
  row: OutlineDisplayRow;
  /** Whether the row holds the list's one Tab stop. */
  active: boolean;
  selected: boolean;
  /** Undefined for a row with nothing under it. */
  expanded: boolean | undefined;
  /** Whether no run can reach the step, as the canvas mutes its card. */
  muted: boolean;
  issues: Parameters<typeof NodeIssueBadge>[0]["issues"];
  edit: { kind: "added" | "modified" | "removed" } | null;
  /** What the open run did at the step, which takes the summary's place. */
  outcome: RunOutcome | undefined;
  /**
   * Whether the outcome names its time. A time shows only where it differs
   * from the row before, since a run's steps often finish within one second.
   */
  showsTime: boolean;
  onChoose: (event: MouseEvent) => void;
  onContextMenu: (event: MouseEvent) => void;
  onFocus: () => void;
  onLeave: () => void;
  onPoint: () => void;
  onToggle: () => void;
}) {
  if (row.kind === "note" || row.kind === "outlet" || row.kind === "parallel") {
    // A heading over the rows behind an outlet or an arm, or a line a run's
    // outline folds rows into. Pressing a heading folds its block; the
    // keyboard folds from the step that opens it.
    const foldable = row.kind !== "note" && expanded !== undefined;
    const text =
      row.kind === "note"
        ? row.text
        : `${row.text}${row.kind === "outlet" && row.detail ? ` · ${row.detail}` : ""}${
            expanded === false ? ` · ${stepsNoun(row.stepCount)}` : ""
          }`;
    return (
      <div
        className="flex min-h-5 cursor-default items-center gap-1 pt-1 pr-2 text-muted-foreground text-xs"
        onClick={foldable ? onToggle : undefined}
        role="none"
        style={{
          paddingLeft:
            indentPx(row.depth) + TEXT_OFFSET_PX - (foldable ? 16 : 0),
        }}
      >
        {foldable ? (
          <FoldToggle expanded={expanded ?? true} onToggle={onToggle} />
        ) : null}
        <span className="min-w-0 truncate">{text}</span>
      </div>
    );
  }

  const focusHandlers = {
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) onLeave();
    },
    onFocus,
  };
  // Fills alone mark a row: a faint one under the pointer and a stronger one
  // when selected, with no border or edge bar.
  const rowClass = cn(
    "flex min-h-6 cursor-default items-center gap-1.5 rounded-md py-1 pr-2 text-xs outline-none",
    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
    selected ? "bg-selection/20" : "hover:bg-foreground/[0.06]"
  );

  if (row.kind === "add") {
    return (
      <div
        aria-level={row.depth + 1}
        className={cn(rowClass, "text-muted-foreground hover:text-foreground")}
        id={outlineRowElementId(row.key)}
        onClick={onChoose}
        role="treeitem"
        style={{ paddingLeft: indentPx(row.depth) }}
        tabIndex={active ? 0 : -1}
        {...focusHandlers}
      >
        <span className="w-5 shrink-0" />
        <Plus aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{row.text}</span>
      </div>
    );
  }

  if (row.kind === "continues") {
    return (
      <div
        aria-level={row.depth + 1}
        className={cn(rowClass, "text-muted-foreground")}
        id={outlineRowElementId(row.key)}
        onClick={onChoose}
        onPointerEnter={onPoint}
        onPointerLeave={onLeave}
        role="treeitem"
        style={{ paddingLeft: indentPx(row.depth) }}
        tabIndex={active ? 0 : -1}
        {...focusHandlers}
      >
        <span className="w-5 shrink-0" />
        <CornerDownRight aria-hidden className="size-3.5 shrink-0" />
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
        rowClass,
        (outcome || (nodeRow.kind === "lifecycle" && nodeRow.overlap)) &&
          "items-start"
      )}
      data-node-id={nodeRow.nodeId}
      id={outlineRowElementId(row.key)}
      onClick={onChoose}
      onContextMenu={onContextMenu}
      onPointerEnter={onPoint}
      onPointerLeave={onLeave}
      role="treeitem"
      style={{ paddingLeft: indentPx(row.depth) }}
      tabIndex={active ? 0 : -1}
      {...focusHandlers}
    >
      <span className="flex h-4 w-5 shrink-0 items-center justify-end text-muted-foreground tabular-nums">
        {nodeRow.kind === "step" ? (
          (nodeRow.number ?? "")
        ) : nodeRow.kind === "group" && expanded !== undefined ? (
          <FoldToggle expanded={expanded} onToggle={onToggle} />
        ) : null}
      </span>
      <span aria-hidden className="flex h-4 w-3.5 shrink-0 items-center">
        <RowGlyph outcome={outcome} row={nodeRow} />
      </span>
      {outcome ? (
        // On a run the label takes the first line and what the run did there
        // takes the second, whole, so a deep row never cuts the outcome.
        <span
          className={cn(
            "flex min-w-0 flex-1 flex-col",
            muted && "text-muted-foreground"
          )}
        >
          <span className={cn("truncate", !muted && "font-medium")}>
            {nodeRow.label}
          </span>
          <span
            className={cn("break-words", OUTCOME_TONE_CLASS[outcome.tone])}
            data-slot="run-outcome"
          >
            {outcome.text}
            {showsTime && outcome.time ? (
              <span className="text-muted-foreground tabular-nums">
                {" "}
                · {outcome.time}
              </span>
            ) : null}
          </span>
        </span>
      ) : nodeRow.kind === "lifecycle" && nodeRow.overlap !== null ? (
        // What starts a run, then what a newer start does to the run already
        // going, whole, since a person cannot see it anywhere else.
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">
            <span className="font-medium">{nodeRow.label}</span>
            {nodeRow.summary ? (
              <span className="text-muted-foreground">
                {" "}
                · {nodeRow.summary}
              </span>
            ) : null}
          </span>
          <span
            className="break-words text-muted-foreground"
            data-slot="overlap"
          >
            {nodeRow.overlap}
          </span>
        </span>
      ) : (
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            muted && "text-muted-foreground"
          )}
        >
          <span className={cn(!muted && "font-medium")}>{nodeRow.label}</span>
          {nodeRow.summary ? (
            <span className="text-muted-foreground"> · {nodeRow.summary}</span>
          ) : null}
        </span>
      )}
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

/** A run outcome's words in the signal its status uses, or muted. */
const OUTCOME_TONE_CLASS: Record<RunOutcome["tone"], string> = {
  done: "text-muted-foreground",
  failed: "text-destructive",
  waiting: "text-warning",
  running: "text-info",
  quiet: "text-muted-foreground",
};

function RowEnd({ children }: { children: ReactNode }) {
  return <span className="flex shrink-0 items-center gap-1">{children}</span>;
}

/**
 * The glyph a row's card leads with on the canvas. On a run, a step that
 * failed or is waiting shows its status glyph in the status colour instead.
 */
function RowGlyph({
  row,
  outcome,
}: {
  row: OutlineNodeRow;
  outcome: RunOutcome | undefined;
}) {
  const catalog = useExtensionCatalog();
  if (outcome?.tone === "failed") {
    return <CircleX className="size-3.5 text-destructive" strokeWidth={2} />;
  }
  if (outcome?.tone === "waiting") {
    return <Clock className="size-3.5 text-warning" strokeWidth={2} />;
  }
  if (row.kind === "lifecycle") {
    return <Play className="size-3.5 text-node-lifecycle" strokeWidth={1.5} />;
  }
  if (row.kind === "group") {
    return (
      <Group className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
    );
  }
  if (row.actionType === undefined) {
    return <Zap className="size-3.5 text-muted-foreground" strokeWidth={1.5} />;
  }
  return (
    <ProviderLogo
      actionType={row.actionType}
      catalog={catalog}
      className="size-3.5"
    />
  );
}

function stepsNoun(count: number): string {
  return count === 1 ? "1 step" : `${count} steps`;
}
