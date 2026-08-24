import { cn } from "@wfgraph/shared/utils";
import {
  comparisonChangeLabel,
  type ComparisonNodeAnnotation,
} from "#src/lib/workflow-graph-types";

const markerStyle: Record<ComparisonNodeAnnotation["kind"], string> = {
  added: "border-success/40 bg-success/10 text-success",
  modified: "border-warning/40 bg-warning/10 text-warning",
  removed: "border-destructive/40 bg-destructive/10 text-destructive",
};

const markerLetter: Record<ComparisonNodeAnnotation["kind"], string> = {
  added: "A",
  modified: "M",
  removed: "D",
};

/** A compact, color-supplemented marker for a node in a publication comparison. */
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
        "absolute top-2 right-2 inline-flex size-5 items-center justify-center rounded-full border font-semibold text-[10px] leading-none",
        markerStyle[comparison.kind],
        className
      )}
      title={comparisonChangeLabel(comparison.kind)}
    >
      {markerLetter[comparison.kind]}
    </span>
  );
}
