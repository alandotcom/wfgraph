import { useAtomValue } from "jotai";
import { ArrowLeft, MoreHorizontal, X } from "lucide-react";
import { Fragment, type Ref } from "react";
import { Button } from "#src/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "#src/components/ui/dropdown-menu";
import {
  type StepMenuItem,
  startsGroup,
  useStepMenuItems,
} from "#src/components/workflow/step-menu-items";
import { stepNumbersAtom } from "#src/lib/step-numbers";
import { nodesAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import {
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
} from "#src/lib/workflow-workspace-navigation";
import {
  type StatusTone,
  statusToneTextClass,
} from "#src/components/workflow/workflow-run-shared";

/** What a subject kind puts in the Inspector's header. */
export type RevealHeaderModel = {
  title: string;
  /** A step's validation status or a run's status, in its signal color. */
  status: { text: string; tone: StatusTone } | null;
  /** Whether Back is offered. */
  showsBack: boolean;
};

/** The shell's commands and refs, which every header wires to its controls. */
export type RevealHeaderControls = {
  /** One step back, as the subject's kind defines it. Escape runs the same. */
  onBack: () => void;
  /**
   * Close the Inspector card and keep the selection, handing focus back to
   * the subject's outline row or card. Escape with nothing left to unwind
   * runs the same.
   */
  onClose: () => void;
  titleRef: Ref<HTMLHeadingElement>;
};

/**
 * A row's label in the Inspector's ⋯ menu. The header already names the
 * subject, so the rows that name it on the canvas's context menu ("Disable
 * Send reminder") name its kind here instead: "Disable step", "Duplicate
 * step", "Delete step", or "Duplicate group" for a Group.
 */
function inspectorMenuLabel(
  item: StepMenuItem,
  node: WorkflowNode | undefined
): string {
  const noun =
    node?.data.type === "action"
      ? "step"
      : node && isGroupNode(node)
        ? "group"
        : null;
  if (noun === null) {
    return item.label;
  }
  if (item.id === "toggle-enabled") {
    return `${node?.data.enabled === false ? "Enable" : "Disable"} ${noun}`;
  }
  if (item.id === "duplicate") {
    return `Duplicate ${noun}`;
  }
  // A Group's delete row already says what it removes.
  if (item.id === "delete" && noun === "step") {
    return "Delete step";
  }
  return item.label;
}

/**
 * The ⋯ menu of a Draft step, Group or Lifecycle node: the commands its
 * context menu on the canvas offers, from the same source, less Edit, since
 * the Inspector already shows its editor.
 */
function StepActionsMenu({ nodeId }: { nodeId: string }) {
  const node = useAtomValue(nodesAtom).find((item) => item.id === nodeId);
  const items = useStepMenuItems({
    nodeId,
    selectedIds: new Set([nodeId]),
  }).filter((item) => item.id !== "edit");
  if (items.length === 0) {
    return null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="More actions"
            size="icon-sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {items.map((item, index) => (
          <Fragment key={item.id}>
            {startsGroup(items, index) ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              disabled={item.disabled}
              onClick={item.run}
              title={item.disabled ? item.hint : undefined}
              variant={item.destructive ? "destructive" : "default"}
            >
              {item.icon}
              {inspectorMenuLabel(item, node)}
              {item.shortcut && !item.disabled ? (
                <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>
              ) : null}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The Inspector's header for the shown object: Back where the model offers
 * it, the step's number and title, its status, a Draft object's ⋯ menu, and
 * Close. It stays put while the body under it scrolls. The title takes focus
 * when a run node's evidence opens, so it carries `tabIndex={-1}`.
 */
export function RevealHeader({
  model,
  controls,
}: {
  model: RevealHeaderModel;
  controls: RevealHeaderControls;
}) {
  const { onBack, onClose, titleRef } = controls;
  const { status } = model;
  const { key } = useAtomValue(activeWorkspaceAddressAtom);
  const selection = useAtomValue(activeSelectionAtom);
  const numbers = useAtomValue(stepNumbersAtom);
  // The one object a Draft selection holds alone. A run's pinned graph
  // numbers its own steps, so only a Draft object shows the draft's number,
  // the one its card and outline row carry.
  const draftNodeId =
    key.workspace === "draft" &&
    selection.nodeIds.length === 1 &&
    selection.edgeIds.length === 0
      ? (selection.nodeIds[0] ?? null)
      : null;
  const number = draftNodeId === null ? undefined : numbers.get(draftNodeId);
  return (
    <header
      className="flex h-12 shrink-0 items-center gap-1 border-b pr-2 pl-3"
      data-slot="inspector-header"
    >
      {model.showsBack ? (
        <Button
          aria-label="Back"
          onClick={onBack}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ArrowLeft />
        </Button>
      ) : null}
      {number === undefined ? null : (
        <span
          className="shrink-0 pl-1 font-semibold text-muted-foreground text-sm tabular-nums"
          data-slot="reveal-number"
        >
          {number}
        </span>
      )}
      <h2
        className="min-w-0 flex-1 truncate px-1 font-semibold text-sm outline-none"
        data-slot="reveal-title"
        ref={titleRef}
        tabIndex={-1}
      >
        {model.title}
      </h2>
      {status ? (
        <span
          className={`shrink-0 px-1 text-xs ${statusToneTextClass(status.tone)}`}
          data-slot="reveal-status"
        >
          {status.text}
        </span>
      ) : null}
      {draftNodeId === null ? null : <StepActionsMenu nodeId={draftNodeId} />}
      <Button
        aria-label="Close"
        onClick={onClose}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <X />
      </Button>
    </header>
  );
}
