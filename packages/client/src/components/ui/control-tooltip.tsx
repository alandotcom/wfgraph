import type { ReactElement, ReactNode } from "react";
import { Kbd } from "#src/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#src/components/ui/tooltip";

/** How long the pointer rests on a control before its tooltip shows. */
const CONTROL_TOOLTIP_DELAY_MS = 500;

/**
 * A toolbar or canvas control's name, and its shortcut as a keycap, in the
 * app's tooltip. It shows after the pointer rests on the control for half a
 * second, and on keyboard focus. `children` is the control itself, which the
 * tooltip renders as its trigger, so the control keeps its own accessible name.
 */
export function ControlTooltip({
  label,
  shortcut,
  side,
  children,
}: {
  label: ReactNode;
  shortcut?: string | undefined;
  side?: "top" | "bottom" | "left" | "right" | undefined;
  children: ReactElement;
}) {
  return (
    <TooltipProvider delay={CONTROL_TOOLTIP_DELAY_MS}>
      <Tooltip>
        <TooltipTrigger render={children} />
        <TooltipContent side={side ?? "bottom"}>
          {label}
          {shortcut === undefined ? null : (
            <Kbd>{shortcut}</Kbd>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
