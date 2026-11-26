import { closeHistoryGroupAtom } from "#src/lib/workflow-graph-cells";
import { useNavigate } from "@tanstack/react-router";
import {
  useAtom,
  useAtomValue,
  useAtomValueRawSync,
  useSetAtom,
  useStore,
} from "jotai";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { DeleteConfirmDialog } from "#src/components/delete-confirm-dialog";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import type {
  ConfirmRequest,
  NodeConfigFrame,
} from "#src/components/workflow/node-config-panel";
import {
  canvasRevealAtom,
  dismissInspectorAtom,
  inspectorOpenAtom,
  inspectorSubjectAtom,
  showCanvasRevealLevelAtom,
  unwoundLevel,
} from "#src/components/workflow/canvas-reveal/canvas-reveal-state";
import {
  RevealHeader,
  type RevealHeaderControls,
} from "#src/components/workflow/canvas-reveal/reveal-header";
import { revealKind } from "#src/components/workflow/canvas-reveal/reveal-kinds";
import {
  revealFieldRequestAtom,
  revealTitleFocusRequestAtom,
} from "#src/components/workflow/canvas-reveal/reveal-requests";
import { useInspectorScroll } from "#src/components/workflow/canvas-reveal/use-inspector-scroll";
import { useRevealKeyboard } from "#src/components/workflow/canvas-reveal/use-reveal-keyboard";
import { focusStepRowOrCard } from "#src/components/workflow/step-focus-landing";
import { useAfterPaint, useBeforePaint } from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import {
  closestScroller,
  scrollIntoScroller,
} from "#src/lib/scroll-into-scroller";
import { nodesAtom } from "#src/lib/workflow-graph-store";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import type { RevealLevel } from "#src/lib/workflow-navigation-state";
import { isReviewSheetShownAtom } from "#src/lib/workflow-review-store";

/**
 * The Inspector's contents. It shows the selected object's editor, or in Runs
 * a run or a run node's evidence, under a header naming it, and nothing while
 * the card has no subject, such as on the run list, since the card is closed
 * then. The subject's
 * kind supplies the header and bodies. Escape and Back take one step back as
 * the kind defines it. With no step left, Escape closes the Inspector as its
 * X does. A run node's evidence opens with focus on its title. Escape, a field
 * request and a title request wait for the card to be open.
 */
export function InspectorContents() {
  // Workspace synchronization can write these before normal subscriptions mount.
  const reveal = useAtomValueRawSync(canvasRevealAtom);
  const subject = useAtomValueRawSync(inspectorSubjectAtom);
  const open = useAtomValueRawSync(inspectorOpenAtom);
  const showLevel = useSetAtom(showCanvasRevealLevelAtom);
  const dismissInspector = useSetAtom(dismissInspectorAtom);
  const nodes = useAtomValue(nodesAtom);
  const issues = useAtomValue(workflowIssuesAtom);
  const catalog = useExtensionCatalog();
  const store = useStore();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const fieldRequest = useAtomValue(revealFieldRequestAtom);
  const setFieldRequest = useSetAtom(revealFieldRequestAtom);
  const [titleFocusRequest, setTitleFocusRequest] = useAtom(
    revealTitleFocusRequestAtom
  );
  const { hasOverlays } = useOverlay();
  // Below `md` the Inspector is not on screen, and the mobile Reveal
  // sheets answer Escape and field requests.
  const isMobile = useIsMobile();
  // The review sheet covers the Inspector while it shows. The Inspector
  // keeps its subject beneath it and comes back as it was when the sheet
  // closes.
  const coveredByReview = useAtomValue(isReviewSheetShownAtom);
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const frame = useMemo<NodeConfigFrame>(() => ({ confirm: setRequest }), []);
  const rootRef = useRef<HTMLElement>(null);
  const closeHistoryGroup = useSetAtom(closeHistoryGroupAtom);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const shownLevelRef = useRef<RevealLevel>(reveal.level);
  // Whether focus was last inside the card. Moving it to an element outside
  // clears this; a focused control leaving the page with its subject does not.
  const focusInsideRef = useRef(false);

  const { level, presentation } = reveal;
  const kind = subject ? revealKind(subject) : null;

  // Opening a run node's evidence moves focus to its title. Every move passes
  // `preventScroll`, so focusing never scrolls the editor shell.
  useBeforePaint(level, () => {
    if (level === "focus" && shownLevelRef.current !== "focus") {
      titleRef.current?.focus({ preventScroll: true });
    }
    shownLevelRef.current = level;
  });

  // A jump inside the card, such as an Event Split's button or Back, replaces
  // the control that held focus, which drops focus to the page body. The new
  // subject's title takes it, so Escape and Tab still reach the card.
  useBeforePaint(`${subject?.key ?? ""}|${open}`, () => {
    const active = document.activeElement;
    if (
      open &&
      focusInsideRef.current &&
      (active === null || active === document.body)
    ) {
      titleRef.current?.focus({ preventScroll: true });
    }
  });

  /**
   * The one way the Inspector closes, for its X and for Escape with nothing
   * left to unwind. Focus goes back to the subject's outline row or card, or
   * else to the canvas element the kind names, before the card slides away
   * and leaves the selection as it is. A field request still waiting is
   * dropped with the card.
   */
  const closeInspector = () => {
    setFieldRequest(null);
    const landed =
      subject?.nodeId != null && focusStepRowOrCard(subject.nodeId);
    if (!landed && subject && kind) {
      kind
        .focusReturnTarget(subject, document.documentElement)
        ?.focus({ preventScroll: true });
    }
    dismissInspector();
  };

  // Back and Escape both run this, so a kind's own unwind answers both.
  const unwindLevel = () => {
    const next = unwoundLevel(level);
    if (next === null) {
      closeInspector();
      return;
    }
    showLevel(next);
  };
  // A field request the subject being left has not answered yet, such as a
  // jump to the start's Events undone at once, belongs to that subject, so
  // Back and Escape drop it rather than answer it the next time the start
  // opens.
  const unwind = (trigger: "back" | "escape") => {
    setFieldRequest(null);
    if (subject && kind?.unwind) {
      kind.unwind({
        subject,
        level,
        trigger,
        store,
        unwindLevel,
        replaceRouteSearch: (search) =>
          void navigate({ search, replace: true }),
      });
    } else {
      unwindLevel();
    }
  };

  // A closed card is out of sight and inert, so it answers no keys, and only
  // an Escape from inside the card is its own.
  useRevealKeyboard({
    enabled: open && subject !== null && !coveredByReview && !isMobile,
    hasOverlays,
    area: rootRef,
    pageBodyCounts: false,
    onUnwind: () => unwind("escape"),
  });
  const {
    ref: scrollRef,
    onScroll,
    onScrollEnd,
    adoptScroll,
    scrollToTop,
  } = useInspectorScroll(
    kind?.shellOwnsScroll && subject?.nodeId
      ? {
          address: reveal.address,
          addressId: reveal.addressId,
          inspectedId: subject.nodeId,
          level,
        }
      : null
  );

  // A field request is answered once the open Inspector shows its node, at
  // Focus for a Runs subject that offers it. A request made while the card is
  // still closed, or before the press that asked has opened it, waits for the
  // card to open, since a closed card is inert. This runs after the scroll restore
  // above, and the field's scroll becomes the position the scope keeps. Only
  // the Inspector's own scrolling body moves, and only when the field is out
  // of view, to its nearest edge, so a field already on screen stays under
  // the pointer and nothing outside the card scrolls.
  useAfterPaint(
    `${fieldRequest?.nodeId ?? ""}|${fieldRequest?.targetId ?? ""}|${subject?.key ?? ""}|${level}|${open}`,
    () => {
      if (
        isMobile ||
        !open ||
        fieldRequest === null ||
        subject === null ||
        subject.nodeId !== fieldRequest.nodeId ||
        (level !== "focus" && subject.levels.includes("focus"))
      ) {
        return;
      }
      setFieldRequest(null);
      const element = document.getElementById(fieldRequest.targetId);
      if (element === null) {
        return;
      }
      element.focus({ preventScroll: true });
      const scroller =
        scrollRef.current ??
        (rootRef.current ? closestScroller(element, rootRef.current) : null);
      if (scroller) {
        scrollIntoScroller(scroller, element);
      }
      adoptScroll();
    }
  );

  // A title request is answered once the open Inspector shows the node it
  // names, after the palette or menu that asked has given focus back.
  useAfterPaint(
    `${titleFocusRequest ?? ""}|${subject?.key ?? ""}|${open}`,
    () => {
      if (
        !isMobile &&
        open &&
        titleFocusRequest !== null &&
        subject?.nodeId === titleFocusRequest
      ) {
        setTitleFocusRequest(null);
        titleRef.current?.focus({ preventScroll: true });
      }
    }
  );

  if (isMobile) {
    return null;
  }

  const headerControls: RevealHeaderControls = {
    onBack: () => unwind("back"),
    onClose: closeInspector,
    titleRef,
  };
  let header: ReactNode = null;
  if (subject && kind?.header.owner === "kind") {
    const { Header } = kind.header;
    header = (
      <Header controls={headerControls} level={level} subject={subject} />
    );
  } else if (subject && kind?.header.owner === "shell") {
    header = (
      <RevealHeader
        controls={headerControls}
        model={kind.header.model(subject, {
          nodes,
          issues,
          catalog,
          presentation,
        })}
      />
    );
  }
  const Body =
    kind && level === "focus" && kind.Focus ? kind.Focus : kind?.Browse;
  const focusField = (targetId?: string) => {
    if (targetId !== undefined && subject?.nodeId) {
      setFieldRequest({ nodeId: subject.nodeId, targetId });
    }
  };
  const body =
    subject && Body ? (
      <Body
        focusField={focusField}
        frame={frame}
        key={subject.kind}
        level={level}
        mobile={null}
        scrollToTop={scrollToTop}
        subject={subject}
      />
    ) : null;

  return (
    <aside
      aria-label={kind?.regionLabel ?? "Inspector"}
      // React Flow already leaves input, textarea, select, and content-editable
      // fields alone. Other focused controls keep the selected step's canvas
      // shortcuts, including Delete and Backspace.
      className="flex min-h-0 flex-1 flex-col"
      data-level={level}
      data-slot="inspector-contents"
      // The review sheet covers the Inspector while it shows, so nothing under
      // it takes focus.
      inert={coveredByReview}
      // Leaving a field ends its run of typing, so the next edit is an undo
      // step of its own.
      onBlur={(event) => {
        closeHistoryGroup();
        if (
          event.relatedTarget instanceof Node &&
          !rootRef.current?.contains(event.relatedTarget)
        ) {
          focusInsideRef.current = false;
        }
      }}
      onFocus={() => {
        focusInsideRef.current = true;
      }}
      ref={rootRef}
    >
      {header}
      {/* The body paints `bg-card`, the tone the config form's sticky
          headings paint, so a heading pinned over scrolled fields matches. */}
      {kind?.shellOwnsScroll ? (
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
      <DeleteConfirmDialog
        confirmLabel={request?.confirmLabel}
        description={request?.message}
        // No dismissal in onConfirm: the dialog's action is an AlertDialog.Close,
        // so it is already going away by the time the handler runs.
        onConfirm={() => request?.onConfirm()}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) {
            setRequest(null);
          }
        }}
        open={request !== null}
        title={request?.title}
      />
    </aside>
  );
}
