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
import { useAfterPaint, useBeforePaint } from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import { nodesAtom } from "#src/lib/workflow-graph-store";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import type { RevealLevel } from "#src/lib/workflow-navigation-state";
import { isReviewSheetShownAtom } from "#src/lib/workflow-review-store";
import { currentWorkflowNameAtom } from "#src/lib/workflow-save-store";
import { WorkflowDetails } from "./workflow-details";

/**
 * The Details tab of the details column. With a selection it shows the
 * selected object's editor, or in Runs the run list, a run, or a run node's
 * evidence, under a header naming it. In Draft with nothing selected it shows
 * the workflow's own details and issues. The subject's kind supplies the
 * header and bodies. Escape and Back take one step back as the kind defines
 * it, and with no step left Escape hands focus back to the selected object on
 * the canvas. A run node's evidence opens with focus on its title.
 */
export function DetailsPanel() {
  // Workspace synchronization can write these before normal subscriptions mount.
  const reveal = useAtomValueRawSync(canvasRevealAtom);
  const showLevel = useSetAtom(showCanvasRevealLevelAtom);
  const nodes = useAtomValue(nodesAtom);
  const issues = useAtomValue(workflowIssuesAtom);
  const workflowName = useAtomValue(currentWorkflowNameAtom);
  const catalog = useExtensionCatalog();
  const store = useStore();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const fieldRequest = useAtomValue(revealFieldRequestAtom);
  const setFieldRequest = useSetAtom(revealFieldRequestAtom);
  const [titleFocusRequest, setTitleFocusRequest] = useAtom(
    revealTitleFocusRequestAtom
  );
  const { hasOverlays } = useOverlay();
  // Below `md` the details column is not on screen, and the mobile Reveal
  // sheets answer Escape and field requests.
  const isMobile = useIsMobile();
  // The review sheet covers the details column while it shows. The column
  // keeps its subject beneath it and comes back as it was when the sheet
  // closes.
  const coveredByReview = useAtomValue(isReviewSheetShownAtom);
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const frame = useMemo<NodeConfigFrame>(() => ({ confirm: setRequest }), []);
  const rootRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const shownLevelRef = useRef<RevealLevel>(reveal.level);

  const { subject, level, presentation } = reveal;
  const kind = subject ? revealKind(subject) : null;

  // Opening a run node's evidence moves focus to its title. Every move passes
  // `preventScroll`, so focusing never scrolls the editor shell.
  useBeforePaint(level, () => {
    if (level === "focus" && shownLevelRef.current !== "focus") {
      titleRef.current?.focus({ preventScroll: true });
    }
    shownLevelRef.current = level;
  });

  /** Hand focus back to the selected object on the canvas, when there is one. */
  const returnFocus = () => {
    if (subject && kind) {
      kind
        .focusReturnTarget(subject, document.documentElement)
        ?.focus({ preventScroll: true });
    }
  };

  // Back and Escape both run this, so a kind's own unwind answers both.
  const unwindLevel = () => {
    const next = unwoundLevel(level);
    if (next === null) {
      returnFocus();
      return;
    }
    showLevel(next);
  };
  const unwind = (trigger: "back" | "escape") => {
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

  useRevealKeyboard({
    enabled: subject !== null && !coveredByReview && !isMobile,
    hasOverlays,
    area: rootRef,
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

  // A field request is answered once the column shows its node, at Focus for
  // a Runs subject that offers it. This runs after the scroll restore above,
  // and the field's scroll becomes the position the scope keeps.
  useAfterPaint(
    `${fieldRequest?.nodeId ?? ""}|${fieldRequest?.targetId ?? ""}|${subject?.key ?? ""}|${level}`,
    () => {
      if (
        isMobile ||
        fieldRequest === null ||
        subject === null ||
        subject.nodeId !== fieldRequest.nodeId ||
        (level !== "focus" && subject.levels.includes("focus"))
      ) {
        return;
      }
      setFieldRequest(null);
      const element = document.getElementById(fieldRequest.targetId);
      element?.focus({ preventScroll: true });
      element?.scrollIntoView?.({ block: "center" });
      adoptScroll();
    }
  );

  // A title request is answered once the column shows the node it names,
  // after the palette or menu that asked has given focus back.
  useAfterPaint(`${titleFocusRequest ?? ""}|${subject?.key ?? ""}`, () => {
    if (
      !isMobile &&
      titleFocusRequest !== null &&
      subject?.nodeId === titleFocusRequest
    ) {
      setTitleFocusRequest(null);
      titleRef.current?.focus({ preventScroll: true });
    }
  });

  if (isMobile) {
    return null;
  }

  const headerControls: RevealHeaderControls = {
    onBack: () => unwind("back"),
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
          workflowName,
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
      aria-label={kind?.regionLabel ?? "Workflow details"}
      // React Flow already leaves input, textarea, select, and content-editable
      // fields alone. Other focused controls keep the selected step's canvas
      // shortcuts, including Delete and Backspace.
      className="flex min-h-0 flex-1 flex-col"
      data-level={level}
      data-slot="details-panel"
      // The review sheet covers the column while it shows, so nothing under
      // it takes focus.
      inert={coveredByReview}
      ref={rootRef}
    >
      {subject === null ? (
        <WorkflowDetails />
      ) : (
        <>
          {header}
          {/* The body paints `bg-card`, the tone the config form's sticky
              headings paint, so a heading pinned over scrolled fields
              matches. */}
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
        </>
      )}
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
    </aside>
  );
}
