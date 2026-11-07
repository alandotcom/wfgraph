import { runRetentionNotice } from "#src/lib/run-retention";
import { cn } from "@wfgraph/shared/utils";

/**
 * The host's run retention window as one quiet line, or nothing when the host
 * keeps every run. Both run lists show it.
 */
export function RunRetentionNote({
  runRetentionMs,
  className,
}: {
  runRetentionMs: number | null;
  className?: string | undefined;
}) {
  const notice = runRetentionNotice(runRetentionMs);
  if (notice === null) return null;
  return (
    <p className={cn("text-muted-foreground text-xs", className)}>{notice}</p>
  );
}
