import { TriangleAlert } from "lucide-react";
import type React from "react";
import { cn } from "@wfgraph/shared/utils";

/**
 * The inline "this configuration is refused" surface.
 *
 * One spelling of the amber, so a restyle happens here rather than in every
 * panel that grew its own. `text` is the weight for a note beside a control;
 * `box` is the weight for a refusal the builder has to act on.
 */
export function WarningCallout({
  children,
  className,
  title,
  variant = "box",
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
  variant?: "box" | "text";
}) {
  if (variant === "text") {
    return (
      <p className={cn("text-warning text-xs", className)}>
        {children}
      </p>
    );
  }

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2",
        className
      )}
    >
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <div className="space-y-0.5">
        {title ? (
          <p className="font-medium text-warning text-xs">
            {title}
          </p>
        ) : null}
        <p className="text-warning text-xs">{children}</p>
      </div>
    </div>
  );
}
