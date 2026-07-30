import { TriangleAlert } from "lucide-react";
import type React from "react";
import { cn } from "@rova/shared/utils";

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
      <p className={cn("text-amber-700 text-xs dark:text-amber-200", className)}>
        {children}
      </p>
    );
  }

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2",
        className
      )}
    >
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
      <div className="space-y-0.5">
        {title ? (
          <p className="font-medium text-amber-700 text-xs dark:text-amber-200">
            {title}
          </p>
        ) : null}
        <p className="text-amber-700 text-xs dark:text-amber-200">{children}</p>
      </div>
    </div>
  );
}
