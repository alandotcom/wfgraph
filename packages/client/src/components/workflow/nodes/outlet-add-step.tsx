/**
 * The + under an outlet nothing leaves yet, the open end of a path. Pressing
 * it adds a step on that outlet, which opens with the list of what it can do,
 * as the + on a connection does.
 */

import { Position, useNodeConnections } from "@xyflow/react";
import { Plus } from "lucide-react";
import { useContext } from "react";
import { InsertStepSlot } from "#src/components/flow-elements/edge";
import { useCardTier } from "#src/components/flow-elements/node";
import { alongOutletSide } from "./outlet-label";

/**
 * How far below a card's bottom edge the + sits, in canvas pixels and never
 * less on screen: clear of the handle, or of the outlet caption the full card
 * draws 32px below its edge.
 */
const BELOW_CARD_PX = 12;
const BELOW_CAPTION_PX = 40;

/**
 * Draws the + under the outlet `handleId` of the step `nodeId` (null for a
 * step's one outlet) while nothing leaves it, at `offset` along the card's
 * bottom side. It shows at the card sizes that draw a title, and only while
 * the canvas offers adding steps. `captioned` says the full card names this
 * outlet in a caption under the handle, which the + then sits below.
 */
export function OutletAddStep(input: {
  nodeId: string;
  handleId: string | null;
  outlet: Position;
  offset: string;
  captioned: boolean;
}) {
  const slot = useContext(InsertStepSlot);
  const tier = useCardTier();
  const connections = useNodeConnections({
    id: input.nodeId,
    handleType: "source",
    ...(input.handleId === null ? {} : { handleId: input.handleId }),
  });
  if (
    slot === null ||
    tier === "number" ||
    input.outlet !== Position.Bottom ||
    connections.length > 0
  ) {
    return null;
  }
  const below =
    input.captioned && tier === "full" ? BELOW_CAPTION_PX : BELOW_CARD_PX;
  return (
    <button
      aria-label="Add a step here"
      // The 20px circle answers a 24px square on screen that starts at its
      // top edge, so it reaches no further up toward the outlet's handle.
      className="nodrag nopan absolute flex size-5 -translate-x-1/2 items-center justify-center rounded-full border border-canvas-line bg-background text-foreground transition-colors before:absolute before:top-0 before:left-1/2 before:size-[calc(24px/var(--rf-zoom,1))] before:-translate-x-1/2 before:content-[''] hover:bg-muted"
      data-slot="outlet-add-step"
      onClick={(event) => {
        event.stopPropagation();
        slot.afterOutlet({
          source: { nodeId: input.nodeId, handle: input.handleId },
        });
      }}
      // The outline's "/" and the step's menu reach the same command from
      // the keyboard, so the + adds no Tab stop to every open end.
      tabIndex={-1}
      style={{
        ...alongOutletSide(input.outlet, input.offset),
        top: `calc(100% + max(${below}px, ${below}px / var(--rf-zoom, 1)))`,
      }}
      title="Add a step here"
      type="button"
    >
      <Plus aria-hidden="true" className="size-3.5" strokeWidth={2} />
    </button>
  );
}
