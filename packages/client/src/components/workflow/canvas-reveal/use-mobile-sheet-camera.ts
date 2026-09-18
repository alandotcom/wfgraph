import { useReactFlow, useStoreApi } from "@xyflow/react";
import { useAtomValue } from "jotai";
import { type RefObject, useRef } from "react";
import { useAfterPaint } from "#src/hooks/effects";
import { viewportAnimationDuration } from "#src/lib/motion";
import { sheetObjectKey } from "#src/lib/mobile-sheet-navigation";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  revealViewport,
  sameWorldCamera,
  viewportFromWorldCamera,
  worldCameraFromViewport,
} from "#src/components/workflow/workflow-viewport";
import {
  canvasRevealAtom,
  type MobileRevealState,
} from "./canvas-reveal-state";
import {
  mobileSheetCameraStep,
  type MobileSheetCameraSlot,
} from "./reveal-camera";
import { usableAboveSheet } from "./reveal-geometry";
import { measureObstacles, subjectBounds } from "./use-reveal-camera";

/**
 * Moves the phone's camera the least it must when a summary sheet opens, so the
 * sheet's subject stays visible above the sheet's top edge. `state` is the
 * mobile Reveal state on screen, null while no sheet shows. `sheet` is the
 * sheet element, measured inside the canvas box it floats over. The hook only
 * places: removing a sheet leaves the camera where it is.
 */
export function useMobileSheetCamera(input: {
  state: MobileRevealState | null;
  sheet: RefObject<HTMLElement | null>;
}): void {
  const flow = useReactFlow<WorkflowNode, WorkflowEdge>();
  const flowStore = useStoreApi();
  const { addressId } = useAtomValue(canvasRevealAtom);
  const shownRef = useRef<MobileSheetCameraSlot | null>(null);
  const { state } = input;
  const next: MobileSheetCameraSlot = state
    ? {
        addressId: state.addressId,
        sheet: {
          depth: state.depth,
          level: state.level,
          inspected: state.sheet.inspected,
        },
      }
    : { addressId, sheet: null };
  const slotKey = next.sheet
    ? `${next.addressId}|${next.sheet.depth}|${next.sheet.level}|${sheetObjectKey(next.sheet.inspected)}`
    : next.addressId;

  useAfterPaint(slotKey, () => {
    const step = mobileSheetCameraStep({ shown: shownRef.current, next });
    shownRef.current = next;
    const sheet = input.sheet.current;
    const area = sheet?.parentElement;
    const { width, height } = flowStore.getState();
    if (step === "keep" || !state || !sheet || !area || width <= 0) {
      return;
    }
    const placed = subjectBounds(state.subject.placement, flow);
    if (placed.bounds.width <= 0 || placed.bounds.height <= 0) {
      return;
    }
    const size = { width, height };
    const areaTop = area.getBoundingClientRect().top;
    const usable = usableAboveSheet({
      canvas: size,
      sheetTop: sheet.getBoundingClientRect().top - areaTop,
      obstacles: measureObstacles(area),
    });
    if (!usable) {
      return;
    }
    const current = worldCameraFromViewport(flow.getViewport(), size);
    const target = worldCameraFromViewport(
      revealViewport({
        viewport: flow.getViewport(),
        usable,
        bounds: placed.bounds,
        optionalBounds: placed.optionalBounds,
      }),
      size
    );
    if (!sameWorldCamera(target, current)) {
      // React Flow's default `smooth` interpolation zooms out and back in on
      // the way, which reverses the camera's direction mid-move.
      void flow.setViewport(viewportFromWorldCamera(target, size), {
        duration: viewportAnimationDuration(),
        interpolate: "linear",
      });
    }
  });
}
