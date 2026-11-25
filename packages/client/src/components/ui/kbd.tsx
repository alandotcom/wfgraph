import type * as React from "react"

import { cn } from "@wfgraph/shared/utils"

/**
 * A keyboard shortcut drawn as a keycap. Every shortcut hint in the editor uses
 * it: the toolbar search field, menu rows, context menu rows, and tooltips.
 * Muted text on the Wash fill measures 4.61:1, and inside a tooltip the cap
 * inverts with the tooltip's own colors.
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 shrink-0 items-center justify-center gap-1 rounded-sm border border-border bg-muted px-1 font-sans text-xs font-medium text-muted-foreground select-none in-data-[slot=tooltip-content]:border-background/30 in-data-[slot=tooltip-content]:bg-background/10 in-data-[slot=tooltip-content]:text-background",
        className
      )}
      {...props}
    />
  )
}

export { Kbd }
