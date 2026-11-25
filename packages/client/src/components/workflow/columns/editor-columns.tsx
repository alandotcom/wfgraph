import { useAtomValue } from "jotai";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { type ReactNode, useRef } from "react";
import { Button } from "#src/components/ui/button";
import { ControlTooltip } from "#src/components/ui/control-tooltip";
import { useDomEvent } from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import { cn } from "@wfgraph/shared/utils";
import { ColumnResizeHandle } from "./column-resize-handle";
import { MobileRevealCovered } from "#src/components/workflow/canvas-reveal/mobile-reveal";
import {
  type ColumnSide,
  columnPreferencesAtom,
  columnWidth,
  phoneShowsMapAtom,
} from "./editor-columns-store";
import { COLUMN_SHORTCUT_KEYS } from "#src/lib/shortcut-label";
import { useColumnControls, useColumnShortcuts } from "./use-column-controls";

const COLUMN_LABELS: Record<ColumnSide, string> = {
  outline: "Outline",
  details: "Details",
};

/** The button that collapses, shows or hides one column, with its shortcut. */
function ColumnToggleButton({ side }: { side: ColumnSide }) {
  const controls = useColumnControls();
  const shape = controls.shapes[side];
  const label = controls.toggleLabel(side);
  const opens = shape === "rail";
  const Icon =
    side === "outline"
      ? opens
        ? PanelLeftOpen
        : PanelLeftClose
      : opens
        ? PanelRightOpen
        : PanelRightClose;
  return (
    <ControlTooltip
      label={label}
      shortcut={COLUMN_SHORTCUT_KEYS[side]}
      side={side === "outline" ? "right" : "left"}
    >
      <Button
        aria-label={label}
        data-slot="column-toggle"
        onClick={() => controls.toggle(side)}
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
      {isMobile ? null : <ColumnToggleButton side={side} />}
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

/**
 * The outline shown over the left of the canvas, between 900px and 1359px
 * while details is docked. Escape inside it, or a press outside it and its
 * rail, closes it.
 */
function OutlineOverlay({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  const preferences = useAtomValue(columnPreferencesAtom);
  const ref = useRef<HTMLElement>(null);
  useDomEvent(document, "pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (
      target !== null &&
      !ref.current?.contains(target) &&
      target.closest('[data-slot="column-rail"]') === null
    ) {
      onClose();
    }
  });
  return (
    <section
      aria-label={COLUMN_LABELS.outline}
      className="absolute inset-y-0 left-0 z-30 flex flex-col border-r bg-sidebar shadow-lg"
      data-column="outline"
      data-slot="editor-column"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
      ref={ref}
      style={{ width: columnWidth("outline", preferences) }}
    >
      {children}
    </section>
  );
}

/**
 * The editor below the toolbar on a phone: the outline fills the width, and
 * the toolbar's Map shows the canvas in its place. The canvas stays mounted
 * under the outline, so its camera and selection survive the switch; it leaves
 * keyboard and screen reader navigation while the outline covers it. Details
 * open as sheets over either one.
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
 * column is docked at its chosen width, a rail when collapsed, or, for the
 * outline at medium widths, a panel over the canvas. Only the person's own
 * collapse and resize controls change them, so a selection never resizes the
 * canvas box. `[` and `]` collapse and show the outline and details.
 */
export function EditorColumns({
  outline,
  canvas,
  details,
  phone,
  overlay,
}: {
  outline: ReactNode;
  canvas: ReactNode;
  details: ReactNode;
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
  const { shapes } = controls;
  if (isMobile) {
    return (
      <div
        className="relative flex min-h-0 min-w-0 flex-1"
        data-slot="editor-columns"
      >
        <PhoneMain outline={outline} phone={phone} showsMap={showsMap}>
          {canvas}
        </PhoneMain>
        {overlay}
      </div>
    );
  }
  const canvasBox = (
    <div
      className="relative min-h-[min(20rem,40dvh)] min-w-0 flex-1"
      data-slot="canvas-box"
    >
      {canvas}
      {shapes.outline === "overlay" ? (
        <OutlineOverlay onClose={controls.closeOutlineOverlay}>
          {outline}
        </OutlineOverlay>
      ) : null}
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
      {shapes.details === "docked" ? (
        <DockedColumn side="details">{details}</DockedColumn>
      ) : (
        <ColumnRail side="details" />
      )}
      {overlay}
    </div>
  );
}
