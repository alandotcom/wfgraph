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
import type { FocusEvent, MouseEvent, ReactNode } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { ComparisonMarker } from "#src/components/flow-elements/comparison-marker";
import { NodeIssueBadge } from "#src/components/flow-elements/node-issue-badge";
import { ProviderLogo } from "#src/components/workflow/nodes/action-node";
import { cn } from "@wfgraph/shared/utils";
import type { RunOutcome } from "./outline-run";
import type { OutlineDisplayRow, OutlineNodeRow } from "./outline-view";

/**
 * One row of the outline as the person sees it: a step, the start, a Group,
 * an Add a step row, a reference to a step drawn elsewhere, or a heading over
 * an outlet's rows. It draws what it is given and reports gestures through
 * its callbacks; `WorkflowOutline` decides what each one does.
 */

/** The DOM id of an outline row, so another surface can return focus to it. */
export function outlineRowElementId(key: string): string {
  return `workflow-outline-row-${encodeURIComponent(key)}`;
}

/** Pixels each level of nesting indents a row. */
const INDENT_PX = 14;

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

export function OutlineRowView({
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
  onFocus: (event: FocusEvent<HTMLElement>) => void;
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
      className={cn(rowClass, outcome && "items-start")}
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
