import { useAtomValue, useSetAtom, useStore } from "jotai";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { useCanvasInteraction } from "#src/components/workflow/canvas-interaction";
import { editFocusTarget } from "#src/components/workflow/canvas-reveal/reveal-edit-target";
import { requestRevealEditFocusAtom } from "#src/components/workflow/canvas-reveal/reveal-requests";
import { showGraphEditRefusal } from "#src/components/workflow/graph-edit-refusal";
import { useAfterCommit, useAfterPaint } from "#src/hooks/effects";
import { openCommandPaletteAtom } from "#src/lib/command-palette-store";
import { isRunInProgress } from "#src/lib/execution-logs";
import { inactiveBranch } from "#src/lib/inactive-branch";
import { scrollIntoScroller } from "#src/lib/scroll-into-scroller";
import { editOfNode, workflowEdits } from "#src/lib/workflow-edits";
import {
  canvasIssuesByNodeIdAtom,
  projectedRunLogsAtom,
} from "#src/lib/workflow-graph-presentation-store";
import {
  canvasSelectionAtom,
  edgesAtom,
  moveStepAtom,
  nodesAtom,
  presentedGraphAtom,
  runNodeEvidenceStatusesAtom,
  runPathAtom,
} from "#src/lib/workflow-graph-store";
import {
  isReviewSheetShownAtom,
  reviewComparisonAtom,
  reviewHighlightAtom,
} from "#src/lib/workflow-review-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import {
  outlineRows,
  type WorkflowOutline as Outline,
  workflowOutline,
  workflowStepNumbers,
} from "@wfgraph/shared/graph/workflow-outline";
import { eventLabel } from "@wfgraph/shared/graph/workflow-summary";
import { OutlineFilter } from "./outline-filter";
import { OutlineRowView, outlineRowElementId } from "./outline-row-view";
import { runOutline } from "./outline-run";
import {
  ancestorKeys,
  foldableKeys,
  isFocusableRow,
  isNodeRow,
  moveFocus,
  type OutlineAddRow,
  type OutlineDisplayRow,
  visibleRows,
  withAddStepRows,
} from "./outline-view";
import {
  outlineRowNodeId,
  useOutlineRowGestures,
} from "./use-outline-row-gestures";

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
 * fold, Enter selects the step and asks the Inspector for focus, and `/` opens
 * the step picker to add a step after the row's step, and Alt+Up and Alt+Down
 * move the step within its sequence. Pointing at or focusing a row puts the
 * pointed tint on its card without moving the camera. A row's clicks and
 * right-click are its card's (`useOutlineRowGestures`), and `OutlineFilter`
 * holds the "Filter steps" field above the rows.
 */
export function WorkflowOutline({
  openRun,
}: {
  /**
   * What the Runs outline already reads about the open run that the outline's
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
  const setHighlight = useSetAtom(reviewHighlightAtom);
  const requestEditFocus = useSetAtom(requestRevealEditFocusAtom);
  const openPalette = useSetAtom(openCommandPaletteAtom);
  const applyMoveStep = useSetAtom(moveStepAtom);
  const runPath = useAtomValue(runPathAtom);
  const runStatuses = useAtomValue(runNodeEvidenceStatusesAtom);
  const runLogs = useAtomValue(projectedRunLogsAtom);
  const runWaits = openRun?.waits ?? NO_WAITS;
  const testSkipped = openRun?.testSkipped ?? NO_NODE_IDS;

  const editing = view === "draft" && !reviewShown;
  // Whether a row answers right-click, Shift-click and Cmd-click, offers its
  // Add a step rows and `/`, and moves steps with Alt+Up and Alt+Down: where
  // the canvas offers the same, by the canvas's own answer.
  const interaction = useCanvasInteraction();
  const authoring = editing && interaction.editsTopology;
  const inserting = editing && interaction.insertsNodes;
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
  // The draft's outline offers a step at every open end of a path, to a
  // person who can add one.
  const draftRows = useMemo(
    () =>
      inserting && graph
        ? withAddStepRows({ rows: outlineRowList, edges: graph.edges })
        : outlineRowList,
    [inserting, graph, outlineRowList]
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
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const treeRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

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

  const focusRow = (key: string) => {
    setFocusedKey(key);
    setFocusRequest((count) => count + 1);
  };

  const { choose, extendSelection, openRowMenu } = useOutlineRowGestures({
    authoring,
    reviewShown,
    edits,
    // A reference row leads to the row of the step it names: the sections
    // around that row unfold and it takes the keyboard.
    revealRow: (nodeId) => {
      const target = rows.find(
        (candidate) => isNodeRow(candidate) && candidate.nodeId === nodeId
      );
      if (target) {
        const above = ancestorKeys(rows, target.key);
        setFolded(new Set([...folded].filter((key) => !above.includes(key))));
        focusRow(target.key);
      }
    },
  });

  const point = (row: OutlineDisplayRow) => {
    const nodeId = outlineRowNodeId(row);
    if (nodeId !== null) setHighlight(nodeId);
  };
  const stopPointing = (row: OutlineDisplayRow) => {
    const nodeId = outlineRowNodeId(row);
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
          const nodeId = outlineRowNodeId(row);
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
    if (!inserting) return;
    openPalette({ id: "add-step", after: row.source });
  };

  /**
   * Open the command palette's step picker to add a step after the row's step.
   * The picker adds on the selected step's one outlet, so the row is selected
   * first. A Condition and an Event Split have several outlets and a Group has
   * none of its own, so those rows say where to add instead.
   */
  const addStepAfter = (row: OutlineDisplayRow) => {
    if (!inserting) return;
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
    if (!authoring) return;
    if (row.kind !== "step") {
      showGraphEditRefusal({ refusal: "Select a step to move it." });
      return;
    }
    showGraphEditRefusal(applyMoveStep({ nodeId: row.nodeId, direction }));
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
      <OutlineFilter
        onChange={setFilter}
        onReturnToRows={() => {
          if (activeKey !== null) focusRow(activeKey);
        }}
        value={filter}
      />
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
                    onFocus={(event) => {
                      setFocusedKey(row.key);
                      // A row the keyboard reached tints its card. A row that
                      // took focus with no ring, as on opening the editor or
                      // from a click, leaves the card to the pointer.
                      if (event.currentTarget.matches(":focus-visible")) {
                        point(row);
                      }
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
