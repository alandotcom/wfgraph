import { cn } from "@wfgraph/shared/utils";
import {
  COMPARISON_CHANGE_KIND_LABEL,
  type ComparisonNodeAnnotation,
} from "#src/lib/workflow-graph-types";

// A full-strength signal disc with the letter in the signal's foreground, which
// clears 4.5:1 in both themes. A signal letter on its own tint measured 4:1.
const markerStyle: Record<ComparisonNodeAnnotation["kind"], string> = {
  added: "bg-success text-success-foreground",
  modified: "bg-warning text-warning-foreground",
  removed: "bg-destructive text-destructive-foreground",
};

const markerLetter: Record<ComparisonNodeAnnotation["kind"], string> = {
  added: "A",
  modified: "M",
  removed: "D",
};

/**
 * A compact, color-supplemented marker for a node in a publication comparison.
 * On the canvas, `.comparison-marker` in `globals.css` grows it against the
 * zoom so the letter never reads smaller than 12px on screen.
 */
export function ComparisonMarker({
  comparison,
  className,
}: {
  comparison: ComparisonNodeAnnotation | undefined;
  className?: string;
}) {
  if (!comparison) {
    return null;
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "comparison-marker absolute top-2 right-2 inline-flex size-5 items-center justify-center rounded-full font-semibold text-xs leading-none",
        markerStyle[comparison.kind],
        className
      )}
      title={COMPARISON_CHANGE_KIND_LABEL[comparison.kind]}
    >
      {markerLetter[comparison.kind]}
    </span>
  );
}
