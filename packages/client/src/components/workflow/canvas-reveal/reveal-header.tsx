import { useStore } from "jotai";
import { ArrowLeft, X } from "lucide-react";
import type { Ref } from "react";
import { Button } from "#src/components/ui/button";
import { detailsFloatOpenAtom } from "#src/components/workflow/columns/editor-columns-store";
import { outlineRowElementId } from "#src/components/workflow/outline/workflow-outline";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import {
  type StatusTone,
  statusToneTextClass,
} from "#src/components/workflow/workflow-run-shared";

/** What a subject kind puts in the Inspector's header. */
export type RevealHeaderModel = {
  title: string;
  /** Ancestors of the shown object, outermost first, ending with the object. */
  path: readonly string[];
  /**
   * The one ancestor in `path`, by index, that opens when pressed, and what
   * pressing it does. The Runs header uses it to reach the run list.
   */
  pathLink?: { index: number; onSelect: () => void } | undefined;
  /** A step's validation status or a run's status, in its signal color. */
  status: { text: string; tone: StatusTone } | null;
  /** Whether Back is offered. */
  showsBack: boolean;
};

/** The shell's commands and refs, which every header wires to its controls. */
export type RevealHeaderControls = {
  /** One step back, as the subject's kind defines it. Escape runs the same. */
  onBack: () => void;
  titleRef: Ref<HTMLHeadingElement>;
};

/**
 * The path's segments joined by "›", with the segment `link` names as a button
 * that runs its `onSelect`.
 */
function RevealPath({
  path,
  link,
}: {
  path: readonly string[];
  link: RevealHeaderModel["pathLink"];
}) {
  const linked = link === undefined ? undefined : path[link.index];
  if (link === undefined || linked === undefined) {
    return path.join(" › ");
  }
  const before = path.slice(0, link.index);
  const after = path.slice(link.index + 1);
  return (
    <>
      {before.map((segment) => `${segment} › `).join("")}
      <button
        className="rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        onClick={link.onSelect}
        type="button"
      >
        {linked}
      </button>
      {after.map((segment) => ` › ${segment}`).join("")}
    </>
  );
}

/**
 * Close the Inspector card, leaving the selection as it is, and hand focus to
 * the selected step's outline row, or else to its card on the canvas.
 */
function useCloseInspector(): () => void {
  const store = useStore();
  return () => {
    const [nodeId] = store.get(activeSelectionAtom).nodeIds;
    if (nodeId !== undefined) {
      (
        document.getElementById(outlineRowElementId(nodeId)) ??
        document.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${CSS.escape(nodeId)}"]`
        )
      )?.focus({ preventScroll: true });
    }
    store.set(detailsFloatOpenAtom, false);
  };
}

/**
 * The Inspector's header for the shown object: its title, the path to
 * it, and its status, with Back where the model offers it. The title takes
 * focus when a run node's evidence opens, so it carries `tabIndex={-1}`.
 */
export function RevealHeader({
  model,
  controls,
}: {
  model: RevealHeaderModel;
  controls: RevealHeaderControls;
}) {
  const { onBack, titleRef } = controls;
  const { status } = model;
  const closeInspector = useCloseInspector();
  return (
    <header className="shrink-0 border-b px-3 py-2">
      <div className="flex items-center gap-1">
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
        <h2
          className="min-w-0 flex-1 truncate px-1 font-semibold text-sm outline-none"
          data-slot="reveal-title"
          ref={titleRef}
          tabIndex={-1}
        >
          {model.title}
        </h2>
        <Button
          aria-label="Close"
          onClick={closeInspector}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <X />
        </Button>
      </div>
      {model.path.length > 0 || status ? (
        <div className="flex items-baseline justify-between gap-3 pt-1 pl-1">
          <p
            className="min-w-0 truncate text-muted-foreground text-xs"
            data-slot="reveal-path"
          >
            <RevealPath link={model.pathLink} path={model.path} />
          </p>
          {status ? (
            <span
              className={`shrink-0 text-xs ${statusToneTextClass(status.tone)}`}
            >
              {status.text}
            </span>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
