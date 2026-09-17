import { ArrowLeft, Maximize2, Minimize2, X } from "lucide-react";
import type { Ref } from "react";
import { Button } from "#src/components/ui/button";
import type { OpenRevealLevel } from "#src/lib/workflow-navigation-state";

/** What a subject kind puts in Canvas Reveal's context header. */
export type RevealHeaderModel = {
  /** The workspace chip, or null where the title already names the workspace. */
  workspaceLabel: string | null;
  title: string;
  /** Ancestors of the shown object, outermost first, ending with the object. */
  path: readonly string[];
  status: { text: string; tone: "muted" | "warning" | "destructive" } | null;
  /** Whether Back is offered. Close is always offered. */
  showsBack: boolean;
};

/** The shell's level commands and refs, which every header wires to its buttons. */
export type RevealHeaderControls = {
  /** Whether the subject offers Focus, and so whether the Focus toggle shows. */
  canFocus: boolean;
  /** One step back, as the subject's kind defines it. Escape runs the same. */
  onBack: () => void;
  onToggleFocus: () => void;
  onClose: () => void;
  titleRef: Ref<HTMLHeadingElement>;
  focusToggleRef: Ref<HTMLButtonElement>;
};

const STATUS_TONE_CLASS = {
  muted: "text-muted-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
} as const;

/**
 * Canvas Reveal's context header: the workspace, the object shown, the path to
 * it, and its validation status, with Back, the Focus toggle, and Close. The
 * title takes focus when Focus opens, so it carries `tabIndex={-1}`.
 */
export function RevealHeader({
  model,
  level,
  controls,
}: {
  model: RevealHeaderModel;
  level: OpenRevealLevel;
  controls: RevealHeaderControls;
}) {
  const { canFocus, onBack, onToggleFocus, onClose, titleRef, focusToggleRef } =
    controls;
  const { status } = model;
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
        {model.workspaceLabel === null ? null : (
          <span className="shrink-0 rounded-md border px-1.5 py-0.5 text-muted-foreground text-xs">
            {model.workspaceLabel}
          </span>
        )}
        <h2
          className="min-w-0 flex-1 truncate px-1 font-semibold text-sm outline-none"
          ref={titleRef}
          tabIndex={-1}
        >
          {model.title}
        </h2>
        {canFocus ? (
          <Button
            onClick={onToggleFocus}
            ref={focusToggleRef}
            size="sm"
            type="button"
            variant="outline"
          >
            {level === "focus" ? <Minimize2 /> : <Maximize2 />}
            {level === "focus" ? "Return to summary" : "Focus editor"}
          </Button>
        ) : null}
        <Button
          aria-label="Close"
          onClick={onClose}
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
            {model.path.join(" › ")}
          </p>
          {status ? (
            <span
              className={`shrink-0 text-xs ${STATUS_TONE_CLASS[status.tone]}`}
            >
              {status.text}
            </span>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
