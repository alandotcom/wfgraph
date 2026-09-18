import { useAtomValue, useSetAtom } from "jotai";
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { useAfterDelay, useUnmountCleanup } from "#src/hooks/effects";
import {
  clampRevealWidth,
  revealWidth,
  revealWidthKey,
  revealWidthRange,
  type RevealFocusWidth,
} from "./reveal-geometry";
import {
  finishRevealResizeAtom,
  rememberedRevealWidthsAtom,
  resetRevealWidthAtom,
  resizeRevealWidthAtom,
  startRevealKeyResizeAtom,
} from "./reveal-width-preference";

/** How far one arrow key press widens or narrows Canvas Reveal. */
const KEYBOARD_RESIZE_STEP = 16;

/**
 * How long after a resize key is released a keyboard resize finishes, in
 * milliseconds, when no other resize key is pressed in that time.
 */
export const KEYBOARD_RESIZE_SETTLE_MS = 300;

/** Where a drag started: the pointer's x and the width Reveal had then. */
type DragStart = { clientX: number; width: number; changed: boolean };

/**
 * The separator on Canvas Reveal's left edge that resizes the open level. A
 * drag shows each width as the pointer moves and finishes on release, which
 * keeps the width in its cookie and places the subject once. Arrow keys resize
 * in 16px steps and Home and End go to the narrowest and widest width. Key
 * presses in quick succession are one resize, which finishes 300ms after the
 * last key is released or when focus leaves the handle.
 * Double-clicking forgets the chosen width. Renders nothing on a canvas box
 * narrower than 1024px.
 */
export function RevealResizeHandle(input: {
  level: "browse" | "focus";
  focusWidth: RevealFocusWidth;
  canvasWidth: number;
}) {
  const remembered = useAtomValue(rememberedRevealWidthsAtom);
  const resize = useSetAtom(resizeRevealWidthAtom);
  const finish = useSetAtom(finishRevealResizeAtom);
  const reset = useSetAtom(resetRevealWidthAtom);
  const dragRef = useRef<DragStart | null>(null);
  const startKeyResize = useSetAtom(startRevealKeyResizeAtom);
  /** Whether a keyboard resize has changed the width and not yet finished. */
  const keyResizePendingRef = useRef(false);
  /** Whether a resize key is down, so the settle timer waits for its release. */
  const resizeKeyDownRef = useRef(false);
  /** Counts resize key releases; each one restarts the settle timer. */
  const [keyReleases, setKeyReleases] = useState(0);

  const finishKeyResize = () => {
    resizeKeyDownRef.current = false;
    if (keyResizePendingRef.current) {
      keyResizePendingRef.current = false;
      finish();
    }
  };

  useAfterDelay(keyReleases, KEYBOARD_RESIZE_SETTLE_MS, () => {
    if (!resizeKeyDownRef.current) {
      finishKeyResize();
    }
  });
  // Reveal can close in the middle of a keyboard resize.
  useUnmountCleanup(finishKeyResize);

  const key = revealWidthKey(input.level, input.focusWidth);
  const range = revealWidthRange(key, input.canvasWidth);
  if (!range) {
    return null;
  }
  const width = revealWidth(
    input.level,
    input.canvasWidth,
    input.focusWidth,
    remembered
  );

  const showWidth = (next: number): boolean => {
    const clamped = clampRevealWidth(next, range);
    if (clamped === width) {
      return false;
    }
    resize({ key, width: clamped });
    return true;
  };

  const endDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.changed) {
      finish();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const targets: Record<string, number> = {
      // Reveal is anchored to the right, so moving its left edge left widens it.
      ArrowLeft: width + KEYBOARD_RESIZE_STEP,
      ArrowRight: width - KEYBOARD_RESIZE_STEP,
      Home: range.min,
      End: range.max,
    };
    const target = targets[event.key];
    if (target === undefined) {
      return;
    }
    event.preventDefault();
    resizeKeyDownRef.current = true;
    if (showWidth(target) && !keyResizePendingRef.current) {
      keyResizePendingRef.current = true;
      startKeyResize();
    }
  };

  const onKeyUp = () => {
    if (resizeKeyDownRef.current) {
      resizeKeyDownRef.current = false;
      setKeyReleases((count) => count + 1);
    }
  };

  return (
    <div
      aria-label="Resize inspector"
      aria-orientation="vertical"
      aria-valuemax={range.max}
      aria-valuemin={range.min}
      aria-valuenow={width}
      className="group absolute inset-y-0 left-0 z-10 flex w-3 cursor-col-resize touch-none justify-center outline-none select-none"
      data-slot="canvas-reveal-resize-handle"
      onBlur={finishKeyResize}
      onDoubleClick={() => {
        // The reset finishes any keyboard resize in progress along with itself.
        keyResizePendingRef.current = false;
        reset(key);
      }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onLostPointerCapture={endDrag}
      onPointerCancel={endDrag}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) {
          return;
        }
        // Keeps the press from starting a text selection in the panel.
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { clientX: event.clientX, width, changed: false };
      }}
      onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (drag && showWidth(drag.width + drag.clientX - event.clientX)) {
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
        className="my-3 w-0.5 rounded-full bg-transparent transition-colors group-hover:bg-ring group-focus-visible:bg-ring group-focus-visible:ring-2 group-focus-visible:ring-ring/30"
      />
    </div>
  );
}
