import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import type { ReactNode } from "react";
import {
  type CanvasRevealState,
  canvasRevealAtom,
} from "#src/components/workflow/canvas-reveal/canvas-reveal-state";
import { MobileRevealCovered } from "#src/components/workflow/canvas-reveal/mobile-reveal";
import { placementNodeIds } from "#src/components/workflow/canvas-reveal/reveal-geometry";
import { requestRevealPlacementAtom } from "#src/components/workflow/canvas-reveal/reveal-requests";
import { useAfterCommit } from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import {
  detailsFloatOpenAtom,
  phoneShowsMapAtom,
} from "./editor-columns-store";
import {
  useFindStepShortcut,
  useOutlineControls,
  useOutlineShortcut,
} from "./use-outline-controls";

/** The Inspector card's width, in pixels. */
export const INSPECTOR_WIDTH_PX = 340;

/** The gap between the Inspector card and the canvas box's edges, in pixels. */
const INSPECTOR_INSET_PX = 8;

/**
 * The room the floating outline leaves at the bottom of the canvas for the
 * zoom controls in the bottom-left corner, in pixels.
 */
const OUTLINE_BOTTOM_CLEARANCE_PX = 184;

/**
 * Whether the Inspector has something to show on desktop: any Draft subject,
 * or in Runs an open run. The run list is the floating outline's, so its
 * address is no subject here.
 */
function inspectorHasSubject(reveal: CanvasRevealState): boolean {
  const { key } = reveal.address;
  if (key.workspace === "runs" && key.executionId === null) {
    return false;
  }
  return reveal.subject !== null;
}

/**
 * The outline floating at the top left of the canvas: plain rows over the
 * canvas, with no box, capped at the canvas height less the zoom controls'
 * room and scrolling inside itself. A soft shadow in the canvas colour behind
 * its text keeps it legible over cards and connections. It takes the pointer
 * only where its rows are, so the canvas around them stays usable.
 */
function FloatingOutline({ children }: { children: ReactNode }) {
  return (
    <section
      aria-label="Outline"
      className="pointer-events-none absolute top-3 left-3 z-10 flex w-72 flex-col [text-shadow:0_0_2px_var(--background),0_0_6px_var(--background)]"
      data-column="outline"
      data-slot="floating-outline"
      style={{
        maxHeight: `calc(100% - 12px - ${OUTLINE_BOTTOM_CLEARANCE_PX}px)`,
      }}
    >
      <div className="pointer-events-auto flex min-h-0 flex-col">
        {children}
      </div>
    </section>
  );
}

/**
 * The Inspector: one card floating at the right edge of the canvas, holding
 * the details panel. It slides in on `open` and out again without changing
 * the canvas box, so nothing reflows. Closed it stays mounted, out of sight and
 * inert, so the panel keeps its state. `data-covers-width` tells the canvas
 * camera how much of the canvas it covers while open, with its inset, because
 * it may still be sliding in when the camera measures.
 */
function InspectorCard({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-label="Inspector"
      className="absolute inset-y-2 right-2 z-20 flex flex-col overflow-clip rounded-xl border bg-card shadow-lg transition-transform duration-200 ease-out motion-reduce:transition-none"
      data-covers-width={open ? INSPECTOR_WIDTH_PX + INSPECTOR_INSET_PX : 0}
      data-open={open}
      data-slot="details-float"
      inert={!open}
      style={{
        width: INSPECTOR_WIDTH_PX,
        transform: open
          ? "translateX(0)"
          : `translateX(calc(100% + ${INSPECTOR_INSET_PX}px))`,
      }}
    >
      {children}
    </section>
  );
}

/**
 * The pixels the agent's box keeps clear at the left of the canvas, for the
 * zoom controls in the bottom-left corner.
 */
const COMPOSER_LEFT_CLEARANCE_PX = 64;

/** The gap between the agent's box and the canvas box's right edge. */
const COMPOSER_RIGHT_GAP_PX = 12;

/**
 * The box the agent's prompt line and conversation are laid out in: the
 * height of the canvas less 12px at the top and bottom, clear of the zoom
 * controls on the left, and clear of the Inspector on the right while it is
 * open. It takes no pointer events itself, so the canvas around the line
 * stays usable.
 */
function ComposerBox({
  inspectorOpen,
  children,
}: {
  inspectorOpen: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-y-3 z-10"
      data-slot="agent-composer-box"
      style={{
        left: COMPOSER_LEFT_CLEARANCE_PX,
        right: inspectorOpen
          ? INSPECTOR_WIDTH_PX + INSPECTOR_INSET_PX + COMPOSER_RIGHT_GAP_PX
          : COMPOSER_RIGHT_GAP_PX,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Opens the Inspector when the details panel comes to hold a subject, or a
 * different one, and closes it when the subject goes. Each opening asks the
 * canvas camera to show the subject's nodes beside the card, which moves the
 * camera only when the card would cover them. A phone has no card.
 */
function useInspectorFollowsSubject(input: { enabled: boolean }): boolean {
  const store = useStore();
  const [open, setOpen] = useAtom(detailsFloatOpenAtom);
  const requestPlacement = useSetAtom(requestRevealPlacementAtom);
  const reveal = useAtomValue(canvasRevealAtom);
  const hasSubject = inspectorHasSubject(reveal);
  const subjectKey = hasSubject
    ? `${reveal.addressId}|${reveal.subject?.key ?? ""}`
    : null;
  useAfterCommit(subjectKey, () => {
    if (!input.enabled) {
      return;
    }
    setOpen(subjectKey !== null);
    const { addressId, subject } = store.get(canvasRevealAtom);
    const nodeIds = placementNodeIds(subject?.placement);
    if (subjectKey !== null && nodeIds.length > 0) {
      requestPlacement({ addressId, nodeIds });
    }
  });
  return open && hasSubject;
}

/**
 * The editor below the toolbar on a phone: the outline fills the width, and
 * the toolbar's Map shows the canvas in its place. The canvas stays mounted
 * under the outline, so its camera and selection survive the switch; it leaves
 * keyboard and screen reader navigation while the outline covers it. Details
 * open as sheets over either one. The agent's prompt line sits below this box
 * rather than over it, so the outline and the map scroll clear of it.
 */
function PhoneMain({
  outline,
  phone,
  showsMap,
  children,
}: {
  outline: ReactNode;
  phone: ReactNode;
  showsMap: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="relative min-h-[min(20rem,40dvh)] min-w-0 flex-1"
      data-slot="canvas-box"
    >
      <div className="contents" inert={!showsMap}>
        {children}
      </div>
      {showsMap ? null : (
        <MobileRevealCovered>
          <section
            aria-label="Outline"
            className="absolute inset-0 z-10 flex flex-col bg-sidebar"
            data-column="outline"
            data-slot="phone-outline"
          >
            {outline}
          </section>
        </MobileRevealCovered>
      )}
      {phone}
    </div>
  );
}

/**
 * The editor below the toolbar. At `md` and wider the canvas fills it, and
 * everything else floats over the canvas: the outline at the top left, the
 * agent's composer at the bottom, and the Inspector card at the right while
 * the details panel has a subject. The outline comes first in Tab order, then
 * the canvas, the composer and the Inspector. `[` hides and shows the outline.
 */
export function EditorLayout({
  outline,
  canvas,
  details,
  composer,
  phone,
  overlay,
}: {
  outline: ReactNode;
  canvas: ReactNode;
  details: ReactNode;
  /**
   * The build agent's prompt line and conversation, which float at the bottom
   * of the canvas clear of the zoom controls and of the Inspector.
   */
  composer?: ReactNode;
  /**
   * What a phone layers over the outline or the canvas: the agent and the
   * sheets that show details.
   */
  phone?: ReactNode;
  /** What shows over the canvas, the review sheet. */
  overlay?: ReactNode;
}) {
  const controls = useOutlineControls();
  const isMobile = useIsMobile();
  const showsMap = useAtomValue(phoneShowsMapAtom);
  useOutlineShortcut(controls);
  useFindStepShortcut(controls);
  const inspectorOpen = useInspectorFollowsSubject({ enabled: !isMobile });
  if (isMobile) {
    return (
      <div
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        data-slot="editor-layout"
      >
        <PhoneMain outline={outline} phone={phone} showsMap={showsMap}>
          {canvas}
        </PhoneMain>
        {composer ? (
          <div className="shrink-0" data-slot="phone-composer">
            {composer}
          </div>
        ) : null}
        {overlay}
      </div>
    );
  }
  // `overflow-clip` keeps the closed Inspector out of sight past the canvas
  // box's right edge, and leaves the box no scroll container for a focused
  // control to scroll.
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1"
      data-slot="editor-layout"
    >
      <div
        className="relative min-h-[min(20rem,40dvh)] min-w-0 flex-1 overflow-clip"
        data-slot="canvas-box"
      >
        {controls.shown ? <FloatingOutline>{outline}</FloatingOutline> : null}
        {canvas}
        {composer ? (
          <ComposerBox inspectorOpen={inspectorOpen}>{composer}</ComposerBox>
        ) : null}
        <InspectorCard open={inspectorOpen}>{details}</InspectorCard>
      </div>
      {overlay}
    </div>
  );
}
