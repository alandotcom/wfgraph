/**
 * The caption a canvas card draws beside one named outlet handle, such as a
 * Condition's True and False outlets. Offsets are CSS lengths along the side
 * the outlets sit on: from the card's top on the right, from its left on the
 * bottom.
 */

import { Position, useNodeConnections } from "@xyflow/react";
import { Check } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "@wfgraph/shared/utils";
import type { RunPathMark } from "#src/lib/run-path";

/**
 * The classes an outlet caption, on a card or on an edge, adds for the run
 * path. The outlet a run took inverts to Graphite Ink and leads with a check,
 * so it reads as taken without relying on color; one it did not take recedes.
 */
export function runPathCaptionClass(
  mark: RunPathMark | null | undefined
): string | undefined {
  if (mark === "taken") {
    return "inline-flex items-center gap-1 border-foreground bg-foreground text-background";
  }
  return mark === "not-taken" ? "opacity-70" : undefined;
}

/**
 * An outlet caption's words, after a check when the run took the outlet. The
 * words keep their own box beside the check, so a caption that truncates
 * still ends in an ellipsis.
 */
export function RunPathCaptionText(input: {
  mark: RunPathMark | null | undefined;
  children: string;
}) {
  if (input.mark !== "taken") {
    return input.children;
  }
  return (
    <>
      <Check aria-hidden="true" className="size-3 shrink-0" strokeWidth={2.5} />
      <span className="min-w-0 truncate">{input.children}</span>
    </>
  );
}

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
 * The caption naming a Condition branch outlet, such as True, drawn only while
 * no edge leaves the node `nodeId` by the handle `handleId`. An edge leaving by
 * a branch handle draws the branch name on itself, so the card names only an
 * unconnected branch.
 */
export function BranchOutletLabel(input: {
  nodeId: string;
  handleId: string;
  outlet: Position;
  offset: string;
  className?: string | undefined;
  /** On a run's canvas, whether the run left by this outlet. */
  runPath?: RunPathMark | null | undefined;
  children: string;
}) {
  const connections = useNodeConnections({
    id: input.nodeId,
    handleType: "source",
    handleId: input.handleId,
  });
  if (connections.length > 0) {
    return null;
  }
  return (
    <OutletLabel
      className={input.className}
      offset={input.offset}
      outlet={input.outlet}
      runPath={input.runPath}
    >
      {input.children}
    </OutletLabel>
  );
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
  /** On a run's canvas, whether the run left by this outlet. */
  runPath?: RunPathMark | null | undefined;
  children: string;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute rounded-sm border bg-card px-1.5 py-0.5 text-xs text-muted-foreground leading-none",
        input.outlet === Position.Right
          ? "left-full ml-3 -translate-y-1/2"
          : "-bottom-8 -translate-x-1/2",
        input.className,
        runPathCaptionClass(input.runPath)
      )}
      data-slot="outlet-label"
      style={{
        ...alongOutletSide(input.outlet, input.offset),
        maxWidth: input.maxWidth,
      }}
      title={input.title}
    >
      <RunPathCaptionText mark={input.runPath}>
        {input.children}
      </RunPathCaptionText>
    </div>
  );
}
