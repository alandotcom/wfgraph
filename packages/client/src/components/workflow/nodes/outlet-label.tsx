/**
 * The caption a canvas card draws beside one named outlet handle, such as a
 * Condition's True and False outlets. Offsets are CSS lengths along the side
 * the outlets sit on: from the card's top on the right, from its left on the
 * bottom.
 */

import { Position } from "@xyflow/react";
import type { CSSProperties } from "react";
import { cn } from "@wfgraph/shared/utils";

/**
 * The style placing an outlet handle or its label `offset` along the card side
 * `outlet`.
 */
export function alongOutletSide(
  outlet: Position,
  offset: string
): CSSProperties {
  return outlet === Position.Right ? { top: offset } : { left: offset };
}

/**
 * The caption naming one outlet, drawn outside the card at `offset` along the
 * outlet side: beside the handle on the right side, or under it on the bottom.
 */
export function OutletLabel(input: {
  outlet: Position;
  offset: string;
  className?: string | undefined;
  title?: string | undefined;
  /** The widest the caption may draw, as a CSS length. */
  maxWidth?: string | undefined;
  children: string;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute rounded-sm border bg-card px-1.5 py-0.5 text-xs text-muted-foreground leading-none",
        input.outlet === Position.Right
          ? "left-full ml-3 -translate-y-1/2"
          : "-bottom-8 -translate-x-1/2",
        input.className
      )}
      data-slot="outlet-label"
      style={{
        ...alongOutletSide(input.outlet, input.offset),
        maxWidth: input.maxWidth,
      }}
      title={input.title}
    >
      {input.children}
    </div>
  );
}
