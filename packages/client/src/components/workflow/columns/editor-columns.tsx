import { useAtomValue, useSetAtom, useStore } from "jotai";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "#src/components/ui/button";
import { ControlTooltip } from "#src/components/ui/control-tooltip";
import { canvasRevealAtom } from "#src/components/workflow/canvas-reveal/canvas-reveal-state";
import { placementNodeIds } from "#src/components/workflow/canvas-reveal/reveal-geometry";
import { requestRevealPlacementAtom } from "#src/components/workflow/canvas-reveal/reveal-requests";
import { useAfterCommit } from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import { cn } from "@wfgraph/shared/utils";
import { ColumnResizeHandle } from "./column-resize-handle";
import { MobileRevealCovered } from "#src/components/workflow/canvas-reveal/mobile-reveal";
import {
  COLUMN_WIDTHS,
  type ColumnSide,
  columnPreferencesAtom,
  columnWidth,
  detailsFloatOpenAtom,
  outlineFilterFocusRequestAtom,
  phoneShowsMapAtom,
} from "./editor-columns-store";
import { COLUMN_SHORTCUT_KEYS } from "#src/lib/shortcut-label";
import {
  useColumnControls,
  useColumnShortcuts,
  useFindStepShortcut,
} from "./use-column-controls";

const COLUMN_LABELS: Record<ColumnSide, string> = {
  outline: "Outline",
  details: "Details",
};

/** The button that collapses, shows or hides one column, with its shortcut. */
function ColumnToggleButton({
  side,
  inFloat = false,
}: {
  side: ColumnSide;
  /** Whether the button sits in floating details' header, where it closes it. */
  inFloat?: boolean;
}) {
  const controls = useColumnControls();
  const shape = controls.shapes[side];
  const closesFloat = inFloat && shape === "floating";
  const label = closesFloat ? "Close details" : controls.toggleLabel(side);
  const opens = shape === "rail";
  const sideIcons =
    side === "outline"
      ? { open: PanelLeftOpen, close: PanelLeftClose }
      : { open: PanelRightOpen, close: PanelRightClose };
  const Icon = closesFloat ? X : opens ? sideIcons.open : sideIcons.close;
  return (
    <ControlTooltip
      label={label}
      shortcut={COLUMN_SHORTCUT_KEYS[side]}
      side={side === "outline" ? "right" : "left"}
    >
      <Button
        aria-label={label}
        data-slot="column-toggle"
        onClick={() =>
          closesFloat ? controls.closeDetailsFloat() : controls.toggle(side)
        }
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <Icon />
      </Button>
    </ControlTooltip>
  );
}

/**
 * The header row of a side column: what the column holds, and the control that
 * collapses it. `children` is the column's title or its tabs.
 */
export function ColumnHeader({
  side,
  children,
}: {
  side: ColumnSide;
  children: ReactNode;
}) {
  // A phone shows one view at a time and has no column to collapse.
  const isMobile = useIsMobile();
  return (
    <div
      className={cn(
        "flex h-10 shrink-0 items-center gap-2 border-b px-3",
        side === "details" && "flex-row-reverse"
      )}
      data-slot="column-header"
    >
      {isMobile ? null : (
        // Details' header sits in floating details whenever details is not
        // docked, so its control closes the float there.
        <ColumnToggleButton inFloat={side === "details"} side={side} />
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </div>
  );
}

/** A collapsed column: a slim rail holding the control that brings it back. */
function ColumnRail({ side }: { side: ColumnSide }) {
  return (
    <div
      aria-label={COLUMN_LABELS[side]}
      className={cn(
        "flex w-10 shrink-0 flex-col items-center bg-sidebar py-2",
        side === "outline" ? "border-r" : "border-l"
      )}
      data-column={side}
      data-slot="column-rail"
      role="region"
    >
      <ColumnToggleButton side={side} />
    </div>
  );
}

/** A docked column at its chosen width, with the resize handle on its inner edge. */
function DockedColumn({
  side,
  children,
}: {
  side: ColumnSide;
  children: ReactNode;
}) {
  const preferences = useAtomValue(columnPreferencesAtom);
  return (
    <section
      aria-label={COLUMN_LABELS[side]}
      className={cn(
        "relative flex shrink-0 flex-col bg-sidebar",
        side === "outline" ? "border-r" : "border-l"
      )}
      data-column={side}
      data-slot="editor-column"
      style={{ width: columnWidth(side, preferences) }}
    >
      {children}
      <ColumnResizeHandle side={side} />
    </section>
  );
}

/** The gap between floating details and the canvas box's edges, in pixels. */
const FLOAT_INSET_PX = 8;

/**
 * The width of floating details: the details column's narrowest. Details
 * float only where the canvas is too narrow to give the column room, so the
 * float covers as little of the canvas as the column allows.
 */
const FLOATING_DETAILS_WIDTH = COLUMN_WIDTHS.details.min;

/**
 * Details floating over the right of the canvas, for a details column that is
 * not docked. It has the docked column's content at `FLOATING_DETAILS_WIDTH`,
 * and slides in and
 * out on `open` without changing the canvas box, so nothing reflows. Closed it
 * stays mounted, out of sight and inert, so the agent's conversation and the
 * inspector's state survive it. `data-covers-width` tells the canvas camera
 * how much of the canvas it covers while open.
 */
function FloatingDetails({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const width = FLOATING_DETAILS_WIDTH;
  return (
    <section
      aria-label={COLUMN_LABELS.details}
      className="absolute inset-y-2 right-2 z-20 flex flex-col overflow-clip rounded-xl border bg-sidebar shadow-lg transition-transform duration-200 ease-out motion-reduce:transition-none"
      data-column="details"
      data-covers-width={open ? width + FLOAT_INSET_PX : 0}
      data-open={open}
      data-slot="details-float"
      inert={!open}
      style={{
        width,
        transform: open
          ? "translateX(0)"
          : `translateX(calc(100% + ${FLOAT_INSET_PX}px))`,
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
 * controls on the left, and clear of floating details on the right while it
 * is open. It takes no pointer events itself, so the canvas around the line
 * stays usable.
 */
function ComposerBox({
  floatingDetails,
  children,
}: {
  floatingDetails: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-y-3 z-10"
      data-slot="agent-composer-box"
      style={{
        left: COMPOSER_LEFT_CLEARANCE_PX,
        right: floatingDetails
          ? FLOATING_DETAILS_WIDTH + FLOAT_INSET_PX + COMPOSER_RIGHT_GAP_PX
          : COMPOSER_RIGHT_GAP_PX,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Opens floating details when the selection comes to hold something and closes
 * it when the selection empties. Each opening for a selection asks the canvas
 * camera to show the selected nodes beside the panel, which moves the camera
 * only when the panel would cover them. A docked details column ignores the
 * open state, and a phone has none.
 */
function useDetailsFloatFollowsSelection(input: {
  enabled: boolean;
  docked: boolean;
}) {
  const store = useStore();
  const setOpen = useSetAtom(detailsFloatOpenAtom);
  const requestPlacement = useSetAtom(requestRevealPlacementAtom);
  const selection = useAtomValue(activeSelectionAtom);
  const { addressId } = useAtomValue(canvasRevealAtom);
  const selectionKey =
    selection.nodeIds.length + selection.edgeIds.length === 0
      ? null
      : `${addressId}|${selection.nodeIds.join(",")}|${selection.edgeIds.join(",")}`;
  useAfterCommit(selectionKey, () => {
    if (!input.enabled) {
      return;
    }
    setOpen(selectionKey !== null);
    const { subject } = store.get(canvasRevealAtom);
    const nodeIds = placementNodeIds(subject?.placement);
    if (selectionKey !== null && !input.docked && nodeIds.length > 0) {
      requestPlacement({ addressId, nodeIds });
    }
  });
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
            aria-label={COLUMN_LABELS.outline}
            className="absolute inset-0 z-10 flex flex-col bg-sidebar"
            data-column="outline"
            data-slot="editor-column"
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
 * The editor below the toolbar: the outline column, the canvas box, and the
 * details column, left to right, which is also their Tab order. Each side
 * column is docked at its chosen width or a rail. Details that is not docked
 * floats over the right of the canvas while a selection holds something.
 * Only the person's own collapse and resize controls change the docked
 * columns, so a selection never resizes the canvas box. `[` and `]` collapse
 * and show the outline and details.
 */
export function EditorColumns({
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
   * of the canvas clear of the zoom controls and of floating details.
   */
  composer?: ReactNode;
  /**
   * What a phone layers over the outline or the canvas: the agent and the
   * sheets that show details.
   */
  phone?: ReactNode;
  /** What shows over the canvas and details together, the review sheet. */
  overlay?: ReactNode;
}) {
  const controls = useColumnControls();
  const isMobile = useIsMobile();
  const showsMap = useAtomValue(phoneShowsMapAtom);
  useColumnShortcuts(controls, { enabled: !isMobile });
  useFindStepShortcut(controls);
  // "Find a step" may have just brought the outline into view, so its filter
  // field is looked up after the commit that mounted it.
  const filterFocusRequest = useAtomValue(outlineFilterFocusRequestAtom);
  useAfterCommit(filterFocusRequest, () => {
    if (filterFocusRequest === 0) {
      return;
    }
    const field = document.querySelector<HTMLInputElement>(
      '[data-column="outline"] input[aria-label="Filter steps"]'
    );
    field?.focus({ preventScroll: true });
    field?.select();
  });
  const { shapes } = controls;
  useDetailsFloatFollowsSelection({
    enabled: !isMobile,
    docked: shapes.details === "docked",
  });
  if (isMobile) {
    return (
      <div
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        data-slot="editor-columns"
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
  const docksDetails = shapes.details === "docked";
  // `overflow-clip` keeps floating details out of sight past the canvas
  // box's right edge while it is closed, and leaves the box no scroll
  // container for a focused control to scroll.
  const canvasBox = (
    <div
      className="relative min-h-[min(20rem,40dvh)] min-w-0 flex-1 overflow-clip"
      data-slot="canvas-box"
    >
      {canvas}
      {composer ? (
        <ComposerBox floatingDetails={shapes.details === "floating"}>
          {composer}
        </ComposerBox>
      ) : null}
      {docksDetails ? null : (
        <FloatingDetails open={shapes.details === "floating"}>
          {details}
        </FloatingDetails>
      )}
    </div>
  );
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1"
      data-slot="editor-columns"
    >
      {shapes.outline === "docked" ? (
        <DockedColumn side="outline">{outline}</DockedColumn>
      ) : (
        <ColumnRail side="outline" />
      )}
      {canvasBox}
      {docksDetails ? (
        <DockedColumn side="details">{details}</DockedColumn>
      ) : (
        <ColumnRail side="details" />
      )}
      {overlay}
    </div>
  );
}
