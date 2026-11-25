import { useAtomValue, useSetAtom } from "jotai";
import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { cn } from "@wfgraph/shared/utils";
import {
  COLUMN_WIDTHS,
  type ColumnSide,
  clampColumnWidth,
  columnPreferencesAtom,
  columnWidth,
  resetColumnWidthAtom,
  resizeColumnAtom,
  saveColumnPreferencesAtom,
} from "./editor-columns-store";

/** How far one arrow key press widens or narrows a column. */
const KEYBOARD_RESIZE_STEP = 16;

const HANDLE_LABELS: Record<ColumnSide, string> = {
  outline: "Resize outline",
  details: "Resize details",
};

/** Where a drag started: the pointer's x and the column's width then. */
type DragStart = { clientX: number; width: number; changed: boolean };

/**
 * The separator on a docked column's inner edge: the outline's right edge and
 * the details column's left edge. A drag shows each width as the pointer moves
 * and keeps it in the cookie on release. Arrow keys resize in 16px steps, Home
 * and End go to the narrowest and widest width, and each key press keeps its
 * width. Double-clicking forgets the chosen width.
 */
export function ColumnResizeHandle({ side }: { side: ColumnSide }) {
  const preferences = useAtomValue(columnPreferencesAtom);
  const resize = useSetAtom(resizeColumnAtom);
  const save = useSetAtom(saveColumnPreferencesAtom);
  const reset = useSetAtom(resetColumnWidthAtom);
  const dragRef = useRef<DragStart | null>(null);
  const width = columnWidth(side, preferences);
  const { min, max } = COLUMN_WIDTHS[side];
  // Moving the outline's right edge right widens it, and moving the details
  // column's left edge left widens it.
  const direction = side === "outline" ? 1 : -1;

  const showWidth = (next: number): boolean => {
    const clamped = clampColumnWidth(side, next);
    if (clamped === width) {
      return false;
    }
    resize({ side, width: clamped });
    return true;
  };

  const endDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.changed) {
      save();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const targets: Record<string, number> = {
      ArrowRight: width + direction * KEYBOARD_RESIZE_STEP,
      ArrowLeft: width - direction * KEYBOARD_RESIZE_STEP,
      Home: min,
      End: max,
    };
    const target = targets[event.key];
    if (target === undefined) {
      return;
    }
    event.preventDefault();
    if (showWidth(target)) {
      save();
    }
  };

  return (
    <div
      aria-label={HANDLE_LABELS[side]}
      aria-orientation="vertical"
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={width}
      className={cn(
        "group absolute inset-y-0 z-10 flex w-3 cursor-col-resize touch-none justify-center outline-none select-none",
        side === "outline" ? "-right-1.5" : "-left-1.5"
      )}
      data-slot="column-resize-handle"
      onDoubleClick={() => reset(side)}
      onKeyDown={onKeyDown}
      onLostPointerCapture={endDrag}
      onPointerCancel={endDrag}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) {
          return;
        }
        // Keeps the press from starting a text selection in the column.
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { clientX: event.clientX, width, changed: false };
      }}
      onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (
          drag &&
          showWidth(drag.width + direction * (event.clientX - drag.clientX))
        ) {
          drag.changed = true;
        }
      }}
      onPointerUp={(event: PointerEvent<HTMLDivElement>) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        endDrag();
      }}
      role="separator"
      tabIndex={0}
    >
      <span
        aria-hidden
        className="w-0.5 bg-transparent transition-colors group-hover:bg-ring group-focus-visible:bg-ring"
      />
    </div>
  );
}
