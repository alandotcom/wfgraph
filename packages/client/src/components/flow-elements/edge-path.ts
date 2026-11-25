import { getSmoothStepPath, type InternalNode, Position } from "@xyflow/react";
import { compact } from "es-toolkit/array";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  GROUP_REGION_HEADER_HEIGHT,
  GROUP_REGION_INSET,
} from "@wfgraph/shared/graph/workflow-layout-geometry";

/** One complete rounded path per edge, with an optional shared row bend. */
export function getWorkflowEdgePath(
  input: Omit<Parameters<typeof getSmoothStepPath>[0], "centerY"> & { centerY?: number | undefined }
): ReturnType<typeof getSmoothStepPath> {
  return getSmoothStepPath(omitUndefined({ ...input, borderRadius: 16, offset: 16 }));
}

/** The world coordinates of the named handle's outer midpoint. */
const getHandleCoords = (
  node: InternalNode,
  handleType: "source" | "target",
  fallbackPosition: Position,
  handleId?: string | null
): { x: number; y: number; position: Position } => {
  const handles = node.internals.handleBounds?.[handleType];
  const handle =
    (handleId
      ? handles?.find((candidate) => (candidate.id ?? null) === handleId)
      : undefined) ??
    handles?.find((candidate) => candidate.position === fallbackPosition) ??
    handles?.[0];

  if (!handle) return { x: 0, y: 0, position: fallbackPosition };
  const { position } = handle;
  const offset = {
    [Position.Left]: { x: 0, y: handle.height / 2 },
    [Position.Right]: { x: handle.width, y: handle.height / 2 },
    [Position.Top]: { x: handle.width / 2, y: 0 },
    [Position.Bottom]: { x: handle.width / 2, y: handle.height },
  }[position];
  return {
    x: node.internals.positionAbsolute.x + handle.x + offset.x,
    y: node.internals.positionAbsolute.y + handle.y + offset.y,
    position,
  };
};

/** Shared by canvas edges and Reveal placement so labels have one position. */
export const getEdgeParams = (
  source: InternalNode,
  target: InternalNode,
  sourceHandle?: string | null,
  targetHandle?: string | null
) => {
  const start = getHandleCoords(source, "source", Position.Bottom, sourceHandle);
  const end = getHandleCoords(target, "target", Position.Top, targetHandle);
  return {
    sx: start.x,
    sy: start.y,
    tx: end.x,
    ty: end.y,
    sourcePos: start.position,
    targetPos: end.position,
  };
};

/** A rectangle in flow coordinates. */
export type FlowRect = { x: number; y: number; width: number; height: number };

/**
 * The header bands a connection runs through on its way into or out of a
 * Group region: the band of the region holding its target when its source
 * stands outside that region, and of the region holding its source when its
 * target stands outside. A region's header sits above its first members, so a
 * connection reaching a member from above crosses it. `regionBox` answers a
 * region's node box, which starts where its members' positions start; the
 * header band sits `GROUP_REGION_INSET` outside it.
 */
export function crossedRegionHeaders(input: {
  sourceRegionId: string | undefined;
  targetRegionId: string | undefined;
  regionBox: (regionId: string) => FlowRect | undefined;
}): FlowRect[] {
  const { sourceRegionId, targetRegionId } = input;
  if (sourceRegionId === targetRegionId) {
    return [];
  }
  return compact([sourceRegionId, targetRegionId]).flatMap((regionId) => {
    const box = input.regionBox(regionId);
    return box
      ? [
          {
            x: box.x - GROUP_REGION_INSET.left,
            y: box.y - GROUP_REGION_INSET.top,
            width: box.width + GROUP_REGION_INSET.left,
            height: GROUP_REGION_HEADER_HEIGHT,
          },
        ]
      : [];
  });
}
