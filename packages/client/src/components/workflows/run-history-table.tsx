import {
  createColumnHelper,
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo, useRef } from "react";
import { Button } from "#src/components/ui/button";
import {
  formatDuration,
  getStatusBadgeClass,
  getStatusLabel,
} from "#src/components/workflow/workflow-run-shared";
import type { WorkflowExecutionsGlobalResult } from "#src/lib/rpc-client";
import { getRelativeTime } from "@wfgraph/shared/utils/time";
import { cn } from "@wfgraph/shared/utils";

export type RunHistoryTableRow =
  WorkflowExecutionsGlobalResult["items"][number];

const runHistoryTableFeatures = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    datetime: sortFn_datetime,
    basic: sortFn_basic,
  },
});

const columnHelper = createColumnHelper<
  typeof runHistoryTableFeatures,
  RunHistoryTableRow
>();

const EMPTY_RUNS: RunHistoryTableRow[] = [];
const ROW_HEIGHT_PX = 52;
const PAGE_SIZE = 50;
/** Matches `max-h-[min(65vh,32rem)]` so the first paint has a range before measure. */
const VIEWPORT_HEIGHT_PX = 512;

const GRID_TEMPLATE = "minmax(0,1.6fr) 7.5rem 4.5rem 7rem 5.5rem 4.75rem";

/**
 * Reports the scroller's size immediately. The library observer waits on
 * `ownerDocument.defaultView`, which happy-dom leaves null, so tests (and the
 * first paint before a window is attached) would otherwise measure 0×0.
 */
function observeScrollRect(
  instance: { scrollElement: Element | Window | null },
  callback: (rect: { width: number; height: number }) => void
): () => void {
  const element = instance.scrollElement;
  if (!element || !(element instanceof HTMLElement)) {
    return () => undefined;
  }
  const report = () => {
    callback({
      width: element.clientWidth,
      height: element.clientHeight,
    });
  };
  report();
  const Observer =
    element.ownerDocument.defaultView?.ResizeObserver ??
    globalThis.ResizeObserver;
  if (typeof Observer === "undefined") {
    return () => undefined;
  }
  const observer = new Observer(report);
  observer.observe(element);
  return () => observer.disconnect();
}

function formatRunDuration(duration: string | null): string {
  if (!duration) {
    return "—";
  }
  if (Number.isNaN(Number.parseInt(duration, 10))) {
    return duration;
  }
  return formatDuration(duration);
}

function modeLabel(mode: "live" | "test"): string {
  return mode === "test" ? "Test" : "Live";
}

function durationMs(duration: string | null): number {
  if (!duration) {
    return 0;
  }
  const parsed = Number.parseInt(duration, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function createRunHistoryColumns(onOpenRun: (run: RunHistoryTableRow) => void) {
  return columnHelper.columns([
    columnHelper.accessor("workflowName", {
      header: "Workflow",
      sortFn: "alphanumeric",
      cell: (info) => {
        const run = info.row.original;
        return (
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground text-sm">
              {run.workflowName}
            </div>
            <div className="truncate font-mono text-muted-foreground text-xs">
              {run.startEventName ?? run.entityValue ?? run.workflowId}
            </div>
          </div>
        );
      },
    }),
    columnHelper.accessor("status", {
      header: "Status",
      sortFn: "alphanumeric",
      cell: (info) => (
        <span
          className={cn(
            "inline-flex rounded border px-2 py-0.5 font-medium text-xs",
            getStatusBadgeClass(info.getValue())
          )}
        >
          {getStatusLabel(info.getValue())}
        </span>
      ),
    }),
    columnHelper.accessor("runMode", {
      header: "Mode",
      sortFn: "alphanumeric",
      cell: (info) => (
        <span className="text-muted-foreground text-xs">
          {modeLabel(info.getValue())}
        </span>
      ),
    }),
    columnHelper.accessor("startedAt", {
      header: "Started",
      sortFn: "datetime",
      cell: (info) => (
        <span className="text-muted-foreground text-xs">
          {getRelativeTime(info.getValue())}
        </span>
      ),
    }),
    columnHelper.accessor((row) => durationMs(row.duration), {
      id: "duration",
      header: "Duration",
      sortFn: "basic",
      cell: (info) => (
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatRunDuration(info.row.original.duration)}
        </span>
      ),
    }),
    columnHelper.display({
      id: "open",
      header: () => <span className="sr-only">Open</span>,
      cell: (info) => (
        <Button
          onClick={() => {
            onOpenRun(info.row.original);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          Open
        </Button>
      ),
    }),
  ]);
}

function RunHistoryTableLoading() {
  return (
    <div className="p-6 text-muted-foreground text-sm">Loading runs...</div>
  );
}

function RunHistoryTableEmpty() {
  return (
    <div className="p-6 text-muted-foreground text-sm">No runs found.</div>
  );
}

type RunHistoryTableProps = {
  runs: readonly RunHistoryTableRow[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasNextPage: boolean;
  onLoadMore: () => void;
  onOpenRun: (run: RunHistoryTableRow) => void;
};

export function RunHistoryTable({
  runs,
  isLoading,
  isLoadingMore,
  hasNextPage,
  onLoadMore,
  onOpenRun,
}: RunHistoryTableProps) {
  const data = runs.length === 0 ? EMPTY_RUNS : [...runs];
  const columns = useMemo(
    () => createRunHistoryColumns(onOpenRun),
    [onOpenRun]
  );

  const table = useTable(
    {
      features: runHistoryTableFeatures,
      columns,
      data,
      autoResetPageIndex: false,
      initialState: {
        pagination: { pageIndex: 0, pageSize: PAGE_SIZE },
      },
    },
    (state) => ({
      pagination: state.pagination,
      sorting: state.sorting,
    })
  );

  const rows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 8,
    initialRect: { width: 1, height: VIEWPORT_HEIGHT_PX },
    observeElementRect: observeScrollRect,
    getItemKey: (index) => rows[index]?.id ?? index,
  });

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element || !hasNextPage || isLoadingMore) {
      return;
    }
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 240) {
      onLoadMore();
    }
  };

  if (isLoading && runs.length === 0) {
    return <RunHistoryTableLoading />;
  }

  if (runs.length === 0) {
    return <RunHistoryTableEmpty />;
  }

  const pageCount = table.getPageCount();
  const pageIndex = table.state.pagination.pageIndex;
  const canNext = table.getCanNextPage() || hasNextPage;
  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div className="flex min-h-0 flex-col">
      <div
        className="grid items-center border-b bg-card px-4 py-2 font-medium text-muted-foreground text-xs"
        style={{ gridTemplateColumns: GRID_TEMPLATE }}
      >
        {table.getHeaderGroups().map((group) =>
          group.headers.map((header) => {
            const sorted = header.column.getIsSorted();
            const canSort = header.column.getCanSort();
            if (header.isPlaceholder) {
              return <div key={header.id} />;
            }
            if (!canSort) {
              return (
                <div className="text-right" key={header.id}>
                  <table.FlexRender header={header} />
                </div>
              );
            }
            return (
              <button
                className="inline-flex items-center gap-1 text-left hover:text-foreground"
                key={header.id}
                onClick={header.column.getToggleSortingHandler()}
                type="button"
              >
                <table.FlexRender header={header} />
                {sorted === "asc" ? (
                  <ArrowUp className="size-3" />
                ) : sorted === "desc" ? (
                  <ArrowDown className="size-3" />
                ) : null}
              </button>
            );
          })
        )}
      </div>

      <div
        className="max-h-[min(65vh,32rem)] overflow-auto"
        onScroll={onScroll}
        ref={scrollRef}
      >
        {virtualItems.length === 0 ? (
          rows.map((row) => (
            <div
              className="grid w-full items-center border-b px-4 last:border-b-0"
              key={row.id}
              style={{ gridTemplateColumns: GRID_TEMPLATE }}
            >
              {row.getAllCells().map((cell) => (
                <div
                  className={cn(
                    "min-w-0 py-2",
                    cell.column.id === "open" ? "text-right" : undefined
                  )}
                  key={cell.id}
                >
                  <table.FlexRender cell={cell} />
                </div>
              ))}
            </div>
          ))
        ) : (
          <div
            className="relative w-full"
            style={{ height: rowVirtualizer.getTotalSize() }}
          >
            {virtualItems.map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) {
                return null;
              }
              return (
                <div
                  className="absolute grid w-full items-center border-b px-4 last:border-b-0"
                  data-index={virtualRow.index}
                  key={row.id}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                    gridTemplateColumns: GRID_TEMPLATE,
                  }}
                >
                  {row.getAllCells().map((cell) => (
                    <div
                      className={cn(
                        "min-w-0 py-2",
                        cell.column.id === "open" ? "text-right" : undefined
                      )}
                      key={cell.id}
                    >
                      <table.FlexRender cell={cell} />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
        <p className="text-muted-foreground text-xs">
          Page {pageIndex + 1}
          {pageCount > 0 ? ` of ${pageCount}` : ""}
          {` · ${runs.length} loaded`}
        </p>
        <div className="flex items-center gap-2">
          <Button
            disabled={pageIndex === 0}
            onClick={() => {
              table.previousPage();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Previous
          </Button>
          <Button
            disabled={!canNext || isLoadingMore}
            onClick={() => {
              if (table.getCanNextPage()) {
                table.nextPage();
                return;
              }
              onLoadMore();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {isLoadingMore ? "Loading..." : "Next"}
          </Button>
          {hasNextPage ? (
            <Button
              disabled={isLoadingMore}
              onClick={onLoadMore}
              size="sm"
              type="button"
              variant="outline"
            >
              {isLoadingMore ? "Loading..." : "Load more"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
