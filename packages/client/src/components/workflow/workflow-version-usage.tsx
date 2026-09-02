import { Collapsible } from "@base-ui/react/collapsible";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { PanelState } from "#src/components/workflow/workflow-changes-panel-state";
import { versionUsagePollInterval } from "#src/components/workflow/version-usage-poll";
import { orpcQuery } from "#src/lib/rpc-query";
import { getRelativeTime } from "@wfgraph/shared/utils/time";
import type { WorkflowVersionUsageItem } from "@wfgraph/shared/graph/publication-contracts";

export function WorkflowVersionUsage({ workflowId }: { workflowId: string }) {
  const usage = useQuery({
    ...orpcQuery.workflow.getVersionUsage.queryOptions({
      input: { workflowId },
    }),
    staleTime: 30_000,
    refetchInterval: (query) =>
      versionUsagePollInterval(query.state.data?.items),
    meta: { errorMessage: "Unable to check version usage" },
  });
  const items = usage.data?.items;
  const versionCount = items?.length ?? 0;
  const activeRunCount =
    items?.reduce((count, item) => count + item.activeRunCount, 0) ?? 0;
  const summary = usage.isPending
    ? "Loading"
    : usage.isError
      ? "Version usage unavailable"
      : `${versionCount} ${versionCount === 1 ? "version" : "versions"}, ${activeRunCount} active ${activeRunCount === 1 ? "run" : "runs"}`;

  return (
    <section
      aria-busy={usage.isPending || undefined}
      aria-labelledby="version-usage-heading"
    >
      <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2">
        <h3
          className="font-medium text-muted-foreground text-xs"
          id="version-usage-heading"
        >
          In use
          {items
            ? ` · ${versionCount} ${versionCount === 1 ? "version" : "versions"}`
            : ""}
        </h3>
        <span className="text-muted-foreground text-xs" role="status">
          {summary}
        </span>
      </div>
      {usage.isPending ? (
        <div className="flex min-h-28 items-center justify-center border-b p-6 text-center">
          <p className="text-muted-foreground text-sm">Loading version usage</p>
        </div>
      ) : null}
      {usage.isError ? (
        <div className="min-h-28 border-b">
          <PanelState
            actionLabel="Try again"
            label="Unable to check version usage"
            onAction={() => void usage.refetch()}
          />
        </div>
      ) : null}
      {items?.length === 0 ? (
        <p className="border-b px-4 py-4 text-muted-foreground text-xs">
          No current or active versions
        </p>
      ) : null}
      {items?.length ? (
        <div className="divide-y border-b">
          {items.map((item) => (
            <VersionUsageRow item={item} key={item.id} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function VersionUsageRow({ item }: { item: WorkflowVersionUsageItem }) {
  const versionName =
    item.kind === "draft_snapshot" ? "Draft" : `Version ${item.version}`;
  const runLabel =
    item.activeRunCount === 0
      ? "No active runs"
      : `${item.activeRunCount} active ${item.activeRunCount === 1 ? "run" : "runs"}`;
  const catalogWarning = item.catalogMatches
    ? null
    : "Catalog changed since this version";
  const missingActionsWarning =
    item.missingActionIds.length > 0
      ? `${item.missingActionIds.length} ${item.missingActionIds.length === 1 ? "action" : "actions"} missing`
      : null;

  return (
    <Collapsible.Root>
      <Collapsible.Trigger className="group flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium text-xs">
                {versionName}
              </span>
              {item.isCurrent ? (
                <span className="text-muted-foreground text-xs">Current</span>
              ) : null}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs tabular-nums">
              {item.activeRunCount > 0 ? (
                <span aria-hidden className="size-1.5 rounded-full bg-info" />
              ) : null}
              {runLabel}
            </span>
          </span>
          {item.oldestActiveRunAt ? (
            <span className="mt-1 block text-muted-foreground text-xs">
              Oldest run started {getRelativeTime(item.oldestActiveRunAt)}
            </span>
          ) : null}
          {missingActionsWarning ? (
            <span className="mt-1 block text-warning text-xs">
              {missingActionsWarning}
            </span>
          ) : null}
          {catalogWarning ? (
            <span className="mt-1 block text-warning text-xs">
              {catalogWarning}
            </span>
          ) : null}
        </span>
        <ChevronRight
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[panel-open]:rotate-90"
        />
        <span className="sr-only">Toggle details</span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="border-t bg-muted/20 px-4 py-3">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
          <dt className="text-muted-foreground">Actions</dt>
          <dd className="min-w-0 space-y-1">
            {item.actionIds.length === 0 ? (
              <span className="text-muted-foreground">No actions</span>
            ) : (
              item.actionIds.map((actionId) => {
                const missing = item.missingActionIds.includes(actionId);
                return (
                  <div
                    className="flex min-w-0 items-baseline gap-2"
                    key={actionId}
                  >
                    <code className="min-w-0 break-all font-mono text-xs">
                      {actionId}
                    </code>
                    {missing ? (
                      <span className="shrink-0 text-warning">Missing</span>
                    ) : null}
                  </div>
                );
              })
            )}
          </dd>
        </dl>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
