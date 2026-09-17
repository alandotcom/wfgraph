import { useAtomValue, useSetAtom } from "jotai";
import { ChevronLeft } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { DeleteConfirmDialog } from "#src/components/delete-confirm-dialog";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import {
  type ConfirmRequest,
  type NodeConfigFrame,
  useNodeConfigTitle,
} from "#src/components/workflow/node-config-panel";
import { useAfterCommit, useAfterPaint } from "#src/hooks/effects";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useIsMobile } from "#src/hooks/use-mobile";
import { nodesAtom, selectedNodeAtom } from "#src/lib/workflow-graph-store";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import type {
  OpenRevealLevel,
  RevealLevel,
} from "#src/lib/workflow-navigation-state";
import { currentWorkflowNameAtom } from "#src/lib/workflow-save-store";
import {
  canvasRevealAtom,
  showCanvasRevealLevelAtom,
  toggleCanvasRevealAtom,
  unwoundLevel,
} from "./canvas-reveal-state";
import { RevealHeader } from "./reveal-header";
import { REVEAL_INSET, revealWidth } from "./reveal-geometry";
import { revealKind } from "./reveal-kinds";
import { revealFieldRequestAtom } from "./reveal-requests";
import { useInspectorScroll } from "./use-inspector-scroll";
import { useRevealFocusReturn } from "./use-reveal-focus-return";
import { useRevealKeyboard } from "./use-reveal-keyboard";
import { useRevealCanvasWidth } from "./use-reveal-width";

/**
 * Canvas Reveal: the desktop inspector floating over the right of the canvas
 * box, at the fixed width of its Closed, Browse, or Focus level. The subject's
 * kind supplies the header and bodies. Escape, Back, and Close unwind one level
 * at a time and hand focus back to what opened it. Below `md` the
 * configuration sheet replaces it.
 */
export function CanvasReveal() {
  const isMobile = useIsMobile();
  const reveal = useAtomValue(canvasRevealAtom);
  const showLevel = useSetAtom(showCanvasRevealLevelAtom);
  const toggle = useSetAtom(toggleCanvasRevealAtom);
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const nodes = useAtomValue(nodesAtom);
  const issues = useAtomValue(workflowIssuesAtom);
  const workflowName = useAtomValue(currentWorkflowNameAtom);
  const catalog = useExtensionCatalog();
  const panelTitle = useNodeConfigTitle();
  const fieldRequest = useAtomValue(revealFieldRequestAtom);
  const setFieldRequest = useSetAtom(revealFieldRequestAtom);
  const { hasOverlays } = useOverlay();
  const { openSheet } = useConfigurationSheet();
  const canvasWidth = useRevealCanvasWidth();
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const frame = useMemo<NodeConfigFrame>(() => ({ confirm: setRequest }), []);
  const asideRef = useRef<HTMLElement>(null);
  const areaRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusToggleRef = useRef<HTMLButtonElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);

  const { subject, level, address, presentation } = reveal;
  const kind = subject ? revealKind(subject) : null;

  // Narrowing past the breakpoint unmounts Reveal. If it was showing a node,
  // the sheet picks that node up, so one editor is on screen at any width.
  useAfterCommit(isMobile, () => {
    if (isMobile && selectedNodeId && !hasOverlays) {
      openSheet();
    }
  });

  const { returnFocusOnClose } = useRevealFocusReturn({
    addressId: reveal.addressId,
    subjectKey: subject?.key ?? null,
    level,
    aside: asideRef,
    title: titleRef,
    focusToggle: focusToggleRef,
    fallbackTarget: () => {
      const area = asideRef.current?.parentElement;
      return (
        (subject && kind && area
          ? kind.focusReturnTarget(subject, area)
          : null) ?? openButtonRef.current
      );
    },
  });

  const close = (next: RevealLevel) => {
    if (next === "closed") {
      returnFocusOnClose();
    }
    showLevel(next);
  };

  useRevealKeyboard({
    enabled: !isMobile,
    level,
    hasOverlays,
    area: areaRef,
    onToggle: toggle,
    onUnwind: () => close(unwoundLevel(level)),
  });

  // While closed the surface keeps the width of the level it reopens at, so
  // sliding out does not reflow its content.
  const displayedLevel: OpenRevealLevel =
    level !== "closed"
      ? level
      : subject?.levels.includes(presentation.reopenLevel)
        ? presentation.reopenLevel
        : "browse";
  const {
    ref: scrollRef,
    onScroll,
    onScrollEnd,
    adoptScroll,
  } = useInspectorScroll(
    kind?.keepsInspectorScroll && subject?.nodeId && level !== "closed"
      ? {
          address,
          addressId: reveal.addressId,
          inspectedId: subject.nodeId,
          level: displayedLevel,
        }
      : null
  );

  // A field request is answered once its step shows the level holding the
  // field. This runs after the scroll restore above, and the field's scroll
  // becomes the position the scope keeps.
  useAfterPaint(
    `${fieldRequest?.nodeId ?? ""}|${fieldRequest?.fieldKey ?? ""}|${subject?.key ?? ""}|${level}`,
    () => {
      if (
        fieldRequest === null ||
        subject === null ||
        level === "closed" ||
        subject.nodeId !== fieldRequest.nodeId ||
        (level !== "focus" && subject.levels.includes("focus"))
      ) {
        return;
      }
      setFieldRequest(null);
      const element = document.getElementById(fieldRequest.fieldKey);
      element?.focus({ preventScroll: true });
      element?.scrollIntoView?.({ block: "center" });
      adoptScroll();
    }
  );

  if (isMobile) {
    return null;
  }

  const header =
    subject && kind
      ? kind.headerModel(subject, {
          nodes,
          issues,
          workflowName,
          catalog,
          panelTitle,
        })
      : null;
  const Body =
    kind && displayedLevel === "focus" && kind.Focus
      ? kind.Focus
      : kind?.Browse;
  const openFocus = (fieldKey?: string) => {
    showLevel("focus");
    if (fieldKey !== undefined && subject?.nodeId) {
      setFieldRequest({ nodeId: subject.nodeId, fieldKey });
    }
  };
  const body =
    subject && Body ? (
      <Body
        frame={frame}
        key={subject.kind}
        openFocus={openFocus}
        subject={subject}
      />
    ) : null;

  return (
    <>
      {level === "closed" && subject !== null ? (
        <button
          aria-label="Open inspector"
          className="absolute top-1/2 right-0 z-20 flex size-6 -translate-y-1/2 items-center justify-center rounded-l-full border border-r-0 bg-background shadow-sm transition-colors hover:bg-muted"
          onClick={() => showLevel(presentation.reopenLevel)}
          ref={openButtonRef}
          type="button"
        >
          <ChevronLeft className="size-4" />
        </button>
      ) : null}
      <aside
        aria-label={header?.regionLabel ?? "Inspector"}
        // `nokey` keeps React Flow's Backspace and Delete handling away from
        // the selected step while focus is on a control inside Reveal.
        // `overflow-clip` clips the contents and leaves the panel a box that is
        // not a scroll container, so focusing a control inside cannot scroll it.
        className="canvas-reveal nokey absolute z-20 flex flex-col overflow-clip rounded-xl border bg-sidebar shadow-sm transition-transform duration-150 ease-out"
        data-level={level}
        data-slot="canvas-reveal"
        // Closed keeps the surface mounted, so Runs keeps its state, and inert,
        // so tabbing cannot scroll the clipped editor shell to reach it.
        inert={level === "closed"}
        ref={(element) => {
          asideRef.current = element;
          areaRef.current = element?.parentElement ?? null;
        }}
        style={{
          top: REVEAL_INSET,
          right: REVEAL_INSET,
          bottom: REVEAL_INSET,
          width: revealWidth(displayedLevel, canvasWidth),
          transform:
            level === "closed"
              ? `translateX(calc(100% + ${REVEAL_INSET}px))`
              : "translateX(0)",
        }}
      >
        {subject && header ? (
          <RevealHeader
            canFocus={subject.levels.includes("focus")}
            focusToggleRef={focusToggleRef}
            level={displayedLevel}
            model={header}
            onBack={() => close(unwoundLevel(level))}
            onClose={() => close("closed")}
            onToggleFocus={() =>
              showLevel(displayedLevel === "focus" ? "browse" : "focus")
            }
            titleRef={titleRef}
          />
        ) : null}
        {/* The body paints `bg-card`, the tone the config form's sticky
            headings paint, so a heading pinned over scrolled fields matches. */}
        {kind?.keepsInspectorScroll ? (
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-card [scrollbar-gutter:stable]"
            onScroll={onScroll}
            onScrollEnd={onScrollEnd}
            ref={scrollRef}
          >
            {body}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col bg-card">{body}</div>
        )}
      </aside>
      <DeleteConfirmDialog
        confirmLabel={request?.confirmLabel}
        description={request?.message}
        // No dismissal in onConfirm: the dialog's action is an AlertDialog.Close,
        // so it is already going away by the time the handler runs.
        onConfirm={() => request?.onConfirm()}
        onOpenChange={(open) => {
          if (!open) {
            setRequest(null);
          }
        }}
        open={request !== null}
        title={request?.title}
      />
    </>
  );
}
