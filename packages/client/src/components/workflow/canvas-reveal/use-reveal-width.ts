import { useStore as useFlowStore } from "@xyflow/react";
import { useAtomValue } from "jotai";
import { useIsMobile } from "#src/hooks/use-mobile";
import { canvasRevealAtom } from "./canvas-reveal-state";
import { revealOccupiedWidth } from "./reveal-geometry";

/** The canvas width assumed before React Flow has measured its container. */
const UNMEASURED_CANVAS_WIDTH = 1280;

/** The canvas box width Canvas Reveal sizes itself against, in CSS pixels. */
export function useRevealCanvasWidth(): number {
  const measured = useFlowStore((state) => state.width);
  return measured > 0 ? measured : UNMEASURED_CANVAS_WIDTH;
}

/**
 * The width open Canvas Reveal takes from the right of the canvas box, for
 * canvas overlays that sit beside it. 0 while closed and below `md`, where
 * Reveal is not mounted.
 */
export function useRevealOccupiedWidth(): number {
  const isMobile = useIsMobile();
  const { level } = useAtomValue(canvasRevealAtom);
  const canvasWidth = useRevealCanvasWidth();
  return isMobile ? 0 : revealOccupiedWidth(level, canvasWidth);
}
