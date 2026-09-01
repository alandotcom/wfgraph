import type { WorkflowVersionUsageItem } from "@wfgraph/shared/graph/publication-contracts";

const ACTIVE_POLL_MS = 10_000;
const IDLE_POLL_MS = 30_000;

export function versionUsagePollInterval(
  items: readonly WorkflowVersionUsageItem[] | undefined
): number {
  return items?.some((item) => item.activeRunCount > 0)
    ? ACTIVE_POLL_MS
    : IDLE_POLL_MS;
}
