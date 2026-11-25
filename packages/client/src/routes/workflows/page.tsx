import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getRouteApi,
  Link,
  useMatchRoute,
  useNavigate,
} from "@tanstack/react-router";
import { Circle, Copy, MoreHorizontalIcon } from "lucide-react";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { getClientLogger } from "#src/lib/logger";
import { can } from "#src/lib/authorization";
import { readDashboardCapabilities } from "#src/routes/workflows/dashboard-capabilities";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#src/components/ui/alert-dialog";
import { Button } from "#src/components/ui/button";
import { Spinner } from "#src/components/ui/spinner";
import { Checkbox } from "#src/components/ui/checkbox";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#src/components/ui/dropdown-menu";
import { CreateWorkflowDialog } from "#src/components/workflow/create-workflow-dialog";
import { copyWorkflowId } from "#src/components/workflow/workflow-toolbar-chrome";
import { useDocumentTitle } from "#src/hooks/effects";
import { useListRowKeys } from "#src/hooks/use-list-row-keys";
import { WorkflowsPagePalette } from "#src/components/workflows/workflows-page-palette";
import { opensRow } from "#src/lib/row-click";
import { RunRetentionNote } from "#src/components/run-retention-note";
import { RunHistorySearch } from "#src/components/workflows/run-history-search";
import {
  RunHistoryTable,
  type RunHistoryTableRow,
} from "#src/components/workflows/run-history-table";
import { withExecutorReading } from "#src/lib/run-executor-activity";
import { isRunInProgress } from "#src/lib/execution-logs";
import { RUN_POLL_MS } from "#src/components/workflow/use-workflow-runs";
import type { WorkflowSummaryPayload } from "@wfgraph/shared/graph/api-contracts";
import {
  filterRuns,
  runFiltersFromSearch,
  runFilterToSearch,
  toExecutionsQueryInput,
  uniqueNonEmpty,
  type RunFilter,
} from "#src/lib/run-history-filters";
import {
  orpcQuery,
  refreshRunHistory,
  refreshWorkflowList,
  workflowListQueryOptions,
} from "#src/lib/rpc-query";
import type { WorkflowMode } from "#src/lib/workflow-graph-types";
import { publishedModeWord } from "#src/lib/workflow-run-labels";
import {
  formatExactTime,
  getCompactRelativeTime,
} from "@wfgraph/shared/utils/time";
import { cn } from "@wfgraph/shared/utils";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

type GlobalExecutionItem = RunHistoryTableRow;

type RunsCursor = {
  startedAt: string;
  id: string;
};

type ConfirmDeleteState = {
  workflowIds: string[];
  workflowNames: string[];
  title: string;
  description: string;
};

// Above this many workflows, the delete dialog demands the count be typed back.
const logger = getClientLogger("workflows");

const workflowsRouteApi = getRouteApi("/");

const DELETE_CHALLENGE_THRESHOLD = 3;

/** One page of runs. The list is long enough that it is paged, not sliced. */
const RUNS_PAGE_SIZE = 100;

/**
 * Newest first. A module-level function so TanStack can memoise the select by
 * identity instead of re-sorting on every render.
 */
function toSortedWorkflows(
  payload: readonly WorkflowSummaryPayload[]
): WorkflowSummaryPayload[] {
  return payload.toSorted(byUpdatedDesc);
}

function byUpdatedDesc(
  a: WorkflowSummaryPayload,
  b: WorkflowSummaryPayload
): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function getCompletedActionLabel(action: "pause" | "resume" | "delete") {
  if (action === "pause") {
    return "Paused";
  }

  if (action === "resume") {
    return "Resumed";
  }

  return "Deleted";
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

const NO_WORKFLOWS: WorkflowSummaryPayload[] = [];

/** A row that opens its workflow: a hover fill, and a darker one while pressed. */
const OPENABLE_ROW_CLASS = "cursor-pointer hover:bg-muted/60 active:bg-muted";

/**
 * The keyboard focus on a row, which is the list's one Tab stop: the wash the
 * pointer's hover uses, and the 2px ring outline an element with no ring of its
 * own gets.
 */
const FOCUSABLE_ROW_CLASS =
  "outline-none focus-visible:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

/**
 * The one status a workflow row states, answering whether it reaches anyone
 * now. A paused workflow starts no run, and a workflow with no published
 * version has nothing an Event can start, so neither shows a Published mode.
 * Otherwise the row shows the Published mode, Live or Test.
 */
type WorkflowRowState = "paused" | "never_published" | "live" | "test";

function workflowRowState(
  workflow: Pick<
    WorkflowSummaryPayload,
    "isPaused" | "publishedVersionId" | "mode"
  >
): WorkflowRowState {
  if (workflow.isPaused) {
    return "paused";
  }
  if (workflow.publishedVersionId === undefined) {
    return "never_published";
  }
  return workflow.mode;
}

const WORKFLOW_ROW_STATE_LABELS: Record<WorkflowRowState, string> = {
  paused: "Paused",
  never_published: "Never published",
  live: publishedModeWord("live"),
  test: publishedModeWord("test"),
};

/**
 * A workflow's state as a dot beside a word in foreground text. A Live
 * workflow reaches real recipients, so its dot is filled green; Test fills
 * Amber, as the status strip's Published mode does. Paused and Never published
 * reach no one and keep an outline dot in the muted tone.
 */
function WorkflowStateLabel({
  workflow,
}: {
  workflow: WorkflowSummaryPayload;
}) {
  const state = workflowRowState(workflow);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-medium text-foreground text-xs">
      <Circle
        aria-hidden
        className={cn(
          "size-2.5 transition-colors duration-200",
          state === "live" && "fill-current text-success",
          state === "test" && "fill-current text-warning",
          (state === "paused" || state === "never_published") &&
            "text-muted-foreground"
        )}
      />
      {WORKFLOW_ROW_STATE_LABELS[state]}
    </span>
  );
}

/** A list that failed to load, said in the panel with a Retry beside it. */
function ListLoadFailure({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) {
  return (
    <div className="p-3">
      <p className="text-muted-foreground text-sm">{message}</p>
      <Button
        className="mt-2"
        onClick={retry}
        size="sm"
        type="button"
        variant="outline"
      >
        Retry
      </Button>
    </div>
  );
}

export default function WorkflowsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedWorkflowIds, setSelectedWorkflowIds] = useState<Set<string>>(
    new Set()
  );
  // The All Runs filters and search text are written to the route search, so
  // a reload, a shared link, and Back from a run keep them. Each change
  // replaces the history entry, so Back leaves the page instead of undoing a
  // filter. The page reads the URL once and then keeps its own copy, because
  // the field is typed into and a value that waits for the router would move
  // the caret. The search control can change the filters and the text in one
  // handler, so the ref holds the latest pair for the second write to build on.
  const routeSearch = workflowsRouteApi.useSearch();
  const [runFilters, setRunFiltersState] = useState<RunFilter[]>(() =>
    runFiltersFromSearch(routeSearch)
  );
  const [runQuery, setRunQueryState] = useState(routeSearch.q ?? "");
  const runSearchRef = useRef({ filters: runFilters, q: runQuery });
  const writeRunSearch = (patch: { filters?: RunFilter[]; q?: string }) => {
    const next = { ...runSearchRef.current, ...patch };
    runSearchRef.current = next;
    setRunFiltersState(next.filters);
    setRunQueryState(next.q);
    void navigate({
      to: "/",
      replace: true,
      search: omitUndefined({
        filters:
          next.filters.length > 0
            ? next.filters.map(runFilterToSearch)
            : undefined,
        q: next.q === "" ? undefined : next.q,
      }),
    });
  };
  const setRunFilters = (filters: RunFilter[]) => writeRunSearch({ filters });
  const setRunQuery = (q: string) => writeRunSearch({ q });
  const [showSelectedRunsOnly, setShowSelectedRunsOnly] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  // Bumped on every open so the dialog remounts and re-suggests a name. It stays
  // mounted while closing, because that is what its exit animation needs.
  const [createDialogSession, setCreateDialogSession] = useState(0);
  // What the user has typed into the bulk-delete count challenge.
  const [deleteChallenge, setDeleteChallenge] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<ConfirmDeleteState | null>(
    null
  );
  const canReadWorkflows = can(WfGraphOperations.workflowGetAll.id);
  const canCreate = can(WfGraphOperations.workflowCreate.id);
  const canUpdate = can(WfGraphOperations.workflowUpdate.id);
  const canBulkLifecycle = can(WfGraphOperations.workflowBulkLifecycle.id);
  const { canOpenWorkflow, canOpenGlobalRuns } = readDashboardCapabilities();

  useDocumentTitle("Workflows");

  const workflowsQuery = useQuery({
    ...workflowListQueryOptions(),
    select: toSortedWorkflows,
    meta: { errorMessage: "Failed to load workflows" },
    enabled: canReadWorkflows,
  });
  const workflows = workflowsQuery.data ?? NO_WORKFLOWS;
  // A failure with nothing cached is an error, never an empty list. A failed
  // refetch keeps the rows it already has.
  const workflowsLoadFailed =
    workflowsQuery.isError && workflowsQuery.data === undefined;

  // The workflow the router is opening, while the editor route's loader runs.
  // Its row shows a spinner from the press until the editor replaces the page.
  const matchRoute = useMatchRoute();
  const openingMatch = matchRoute({
    to: "/workflows/$workflowId",
    pending: true,
  });
  const openingWorkflowId =
    openingMatch === false ? null : openingMatch.workflowId;

  const workflowRows = useMemo(
    () => workflows.filter((workflow) => workflow.name !== "__current__"),
    [workflows]
  );

  const selectedIds = useMemo(
    () => Array.from(selectedWorkflowIds),
    [selectedWorkflowIds]
  );

  const selectedActionableIds = useMemo(
    () => (canBulkLifecycle ? selectedIds : []),
    [canBulkLifecycle, selectedIds]
  );

  // Selection is pruned against the rows on screen rather than against the
  // fetched list, so a workflow that disappears server-side stops counting
  // without anyone writing to state during a fetch.
  const allSelected =
    workflowRows.length > 0 &&
    workflowRows.every((workflow) => selectedWorkflowIds.has(workflow.id));

  const hasSelectedRunsFilter =
    showSelectedRunsOnly && selectedActionableIds.length > 0;

  // Both arrays are sorted before they reach the query key. Unsorted, the order
  // in which the user ticked the checkboxes would be part of the cache key, and
  // reordering the same selection would refetch.
  const runsFilter = useMemo(
    () =>
      toExecutionsQueryInput({
        filters: runFilters,
        selectedWorkflowIds: selectedActionableIds,
        selectedOnly: hasSelectedRunsFilter,
        limit: RUNS_PAGE_SIZE,
      }),
    [hasSelectedRunsFilter, runFilters, selectedActionableIds]
  );

  // The filters are part of the key, so changing one refetches by itself. That
  // is the whole job of the effect this replaced.
  const runsQuery = useInfiniteQuery({
    ...orpcQuery.workflow.getExecutionsGlobal.infiniteOptions({
      // The contract declares `cursor` as an optional key, so the first page
      // omits it instead of sending `undefined`.
      input: (cursor: RunsCursor | undefined) =>
        omitUndefined({ ...runsFilter, cursor }),
      initialPageParam: undefined as RunsCursor | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      meta: { errorMessage: "Failed to load workflow runs" },
    }),
    enabled: canOpenGlobalRuns,
    // While a loaded run is in progress the history is re-read as the Runs tab
    // reads its runs, so what its row says about the executor stays current,
    // including a run that starts retrying or stalls after it loaded.
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.items.some((item) => isRunInProgress(item.status))
      )
        ? RUN_POLL_MS
        : false,
  });

  // Each row keeps the reading of the page it arrived on, so a row from an
  // older page measures its wait from its own answer. The query refetches
  // every page together, so their arrival is the query's.
  const runs: GlobalExecutionItem[] = useMemo(
    () =>
      runsQuery.data?.pages.flatMap((page) =>
        page.items.map((item) => ({
          ...item,
          activity: withExecutorReading(item.activity, page),
          receivedAtMs: runsQuery.dataUpdatedAt,
        }))
      ) ?? [],
    [runsQuery.data, runsQuery.dataUpdatedAt]
  );
  const visibleRuns = useMemo(
    () => filterRuns(runs, { query: runQuery, filters: runFilters }),
    [runFilters, runQuery, runs]
  );
  const eventSuggestions = useMemo(
    () => uniqueNonEmpty(runs.map((item) => item.startEventName)),
    [runs]
  );
  const entitySuggestions = useMemo(
    () => uniqueNonEmpty(runs.map((item) => item.entityValue)),
    [runs]
  );
  const isLoadingRuns = runsQuery.isPending;
  const isLoadingMoreRuns = runsQuery.isFetchingNextPage;

  const refreshWorkflows = useCallback(
    () => refreshWorkflowList(queryClient),
    [queryClient]
  );

  const refreshRuns = useCallback(
    () => refreshRunHistory(queryClient),
    [queryClient]
  );

  // The write targets the row it was chosen on, so nothing here touches the
  // editor's open-workflow atoms. Those atoms name the workflow the canvas is
  // showing. `hydrateWorkflowAtom` reads a matching id as a reload of the same
  // workflow and keeps the pinned run, the comparison session and the workspace
  // view that a different id would clear.
  const setPublishedMode = useMutation(
    orpcQuery.workflow.update.mutationOptions({
      // The State cell in this table shows the setting being written, and
      // the table is mounted while the write lands. Refetch the list rather
      // than only marking it stale.
      onSuccess: async (_payload, { mode }) => {
        await refreshWorkflowList(queryClient);
        // `update` can write other fields, so its `mode` is optional. This page
        // only ever writes the mode, and a call without one has nothing to say.
        if (mode !== undefined) {
          toast.success(`Published mode set to ${publishedModeWord(mode)}`);
        }
      },
      meta: { errorMessage: "Failed to set Published mode" },
    })
  );

  const writePublishedMode = setPublishedMode.mutate;
  // Published mode is a setting, so the menu item writes it on one click. A
  // person can switch it back from the same menu, and the toast says which
  // value it now holds.
  const changePublishedMode = useCallback(
    (workflow: WorkflowSummaryPayload, mode: WorkflowMode) => {
      if (!(canUpdate && workflow.mode !== mode)) {
        return;
      }

      writePublishedMode({ workflowId: workflow.id, mode });
    },
    [canUpdate, writePublishedMode]
  );

  const toggleSelectAll = (checked: boolean) => {
    if (!checked) {
      setSelectedWorkflowIds(new Set());
      return;
    }

    setSelectedWorkflowIds(
      new Set(workflowRows.map((workflow) => workflow.id))
    );
  };

  const openWorkflow = (workflowId: string) => {
    void navigate({
      to: "/workflows/$workflowId",
      params: { workflowId },
    });
  };

  const openCreateDialog = () => {
    setCreateDialogSession((session) => session + 1);
    setIsCreateDialogOpen(true);
  };

  const toggleSelectOne = (workflowId: string, checked: boolean) => {
    setSelectedWorkflowIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(workflowId);
      } else {
        next.delete(workflowId);
      }
      return next;
    });
  };

  // A plain function rather than `useCallback`: `navigate` also reaches the
  // row-key hook below, and the React Compiler cannot keep a manual memo whose
  // dependency a hook receives. The compiler memoizes this itself.
  const openRun = (item: GlobalExecutionItem) => {
    if (canOpenGlobalRuns) {
      void navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: item.workflowId },
        search: { view: "runs", executionId: item.id },
      });
    }
  };

  const lifecycle = useMutation(
    orpcQuery.workflow.bulkLifecycle.mutationOptions({
      onSuccess: async (result, { action }) => {
        if (result.summary.failed === 0) {
          toast.success(
            `${getCompletedActionLabel(action)} ${result.summary.succeeded} workflow${pluralize(result.summary.succeeded, "", "s")}`
          );
        } else {
          toast.error(
            `${action} finished with ${result.summary.failed} failure${pluralize(result.summary.failed, "", "s")}`
          );
        }

        await refreshWorkflowList(queryClient);

        if (action !== "delete") {
          // Pausing and resuming touch the workflow row and nothing else. The
          // run history is paged, so refetching it here would mean one request
          // per page the user has loaded, for data that cannot have changed.
          return;
        }

        const deletedIds = new Set(
          result.results
            .filter((entry) => entry.ok && entry.deleted === true)
            .map((entry) => entry.workflowId)
        );

        setSelectedWorkflowIds((prev) => {
          const next = new Set<string>();
          for (const id of prev) {
            if (!deletedIds.has(id)) {
              next.add(id);
            }
          }
          return next;
        });

        // Runs cascade with the workflow row.
        await refreshRunHistory(queryClient);
      },
      // Which action failed is worth saying, and a mutation's meta cannot see
      // its own variables.
      onError: (error, { action }) => {
        logger.error(`Failed to ${action} workflows`, { action, error });
        toast.error(`Failed to ${action} workflows`);
      },
      meta: { errorShownByCaller: true },
    })
  );

  // Which action is in flight, not merely that one is: the row menus and the
  // bulk buttons all read this to disable themselves.
  const lifecycleAction = lifecycle.isPending
    ? lifecycle.variables.action
    : null;

  // `mutate` is stable across renders; the mutation object it hangs off is not.
  const runLifecycle = lifecycle.mutate;
  const runLifecycleAction = useCallback(
    (action: "pause" | "resume" | "delete", workflowIds: string[]) => {
      if (!(canBulkLifecycle && workflowIds.length > 0)) {
        return;
      }
      runLifecycle({ workflowIds, action });
    },
    [canBulkLifecycle, runLifecycle]
  );

  const openDeleteConfirmation = useCallback(
    (workflowIds: string[]) => {
      if (!(canBulkLifecycle && workflowIds.length > 0)) {
        return;
      }

      const namesById = new Map(
        workflows.map((workflow) => [workflow.id, workflow.name])
      );
      const workflowNames = workflowIds.map(
        (id) => namesById.get(id) ?? "Untitled workflow"
      );

      const title =
        workflowIds.length === 1 ? "Delete workflow" : "Delete workflows";
      const description =
        workflowIds.length === 1
          ? `This will permanently delete "${workflowNames[0]}" and all of its runs and events. This cannot be undone.`
          : `This will permanently delete ${workflowIds.length} workflows and all of their runs and events. This cannot be undone.`;

      setConfirmDelete({
        workflowIds,
        workflowNames,
        title,
        description,
      });
    },
    [canBulkLifecycle, workflows]
  );

  // The table is one Tab stop: the keys move between rows, Enter opens one,
  // Space ticks its checkbox, and Shift+F10 opens its actions menu.
  const workflowRowsRef = useRef<HTMLTableSectionElement>(null);
  const workflowKeysHintId = useId();
  const workflowRowKeys = useListRowKeys({
    count: workflowRows.length,
    container: workflowRowsRef,
    actions: {
      open: (index) => {
        const workflow = workflowRows[index];
        if (workflow && canOpenWorkflow) {
          openWorkflow(workflow.id);
        }
      },
      toggle: canBulkLifecycle
        ? (index) => {
            const workflow = workflowRows[index];
            if (workflow) {
              toggleSelectOne(
                workflow.id,
                !selectedWorkflowIds.has(workflow.id)
              );
            }
          }
        : undefined,
      openMenu: (index) => {
        workflowRowsRef.current
          ?.querySelector<HTMLElement>(
            `[data-row-index="${index}"] [data-row-menu]`
          )
          ?.click();
      },
    },
  });

  const renderWorkflowContent = () => {
    if (workflowsLoadFailed) {
      return (
        <ListLoadFailure
          message="Workflows could not be loaded."
          retry={() => {
            void workflowsQuery.refetch();
          }}
        />
      );
    }

    if (workflowsQuery.isPending && workflowRows.length === 0) {
      return (
        <div className="p-6 text-muted-foreground text-sm">
          Loading workflows...
        </div>
      );
    }

    if (workflowRows.length === 0) {
      return (
        <div className="p-6 text-muted-foreground text-sm">
          No workflows found.
        </div>
      );
    }

    // `table-fixed` gives every column but Name a fixed slot, so a long name
    // truncates instead of wrapping and every row keeps one height. Below
    // `md` the State and Updated columns drop out and the name cell carries
    // State on a second line.
    return (
      <>
        <table className="w-full table-fixed text-left text-sm">
          <thead className="sticky top-0 z-10 bg-card text-muted-foreground text-xs">
            <tr className="h-9 border-b">
              {canBulkLifecycle ? (
                <th className="w-10 pr-0 pl-4 font-medium">
                  <Checkbox
                    aria-label="Select all workflows"
                    checked={allSelected}
                    onCheckedChange={(checked) => {
                      toggleSelectAll(checked);
                    }}
                  />
                </th>
              ) : null}
              <th className="px-2 font-medium">Name</th>
              <th className="hidden w-36 px-2 font-medium md:table-cell">
                State
              </th>
              <th className="hidden w-16 px-2 font-medium md:table-cell">
                Updated
              </th>
              <th className="w-11 pr-3 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody ref={workflowRowsRef}>
            {workflowRows.map((workflow, index) => {
              const isSelected = selectedWorkflowIds.has(workflow.id);
              const isOpening = openingWorkflowId === workflow.id;
              const isTestMode = workflow.mode === "test";
              const toggleAction = workflow.isPaused ? "resume" : "pause";
              const toggleActionLabel = workflow.isPaused ? "Resume" : "Pause";
              // A workflow with no published version starts no run, so there
              // is nothing for a pause to stop. A paused one can still resume.
              const offersPauseToggle =
                workflow.isPaused || workflow.publishedVersionId !== undefined;

              return (
                <tr
                  {...workflowRowKeys(index)}
                  aria-busy={isOpening || undefined}
                  aria-describedby={workflowKeysHintId}
                  className={cn(
                    "h-11 border-b last:border-b-0",
                    FOCUSABLE_ROW_CLASS,
                    canOpenWorkflow && OPENABLE_ROW_CLASS,
                    isOpening && "bg-muted"
                  )}
                  key={workflow.id}
                  onClick={(event) => {
                    if (canOpenWorkflow && opensRow(event)) {
                      openWorkflow(workflow.id);
                    }
                  }}
                >
                  {canBulkLifecycle ? (
                    <td className="pr-0 pl-4">
                      <Checkbox
                        aria-label={`Select ${workflow.name}`}
                        checked={isSelected}
                        onCheckedChange={(checked) => {
                          toggleSelectOne(workflow.id, checked);
                        }}
                        // Space on the row ticks it, so it is no Tab stop.
                        tabIndex={-1}
                      />
                    </td>
                  ) : null}
                  <td className="px-2 py-1.5">
                    <div className="flex min-w-0 items-center gap-2">
                      {canOpenWorkflow ? (
                        // A real link, so a keyboard user can reach it and a
                        // middle click or Cmd+click opens a new tab. Preloading
                        // stays off because the editor route's loader writes the
                        // open workflow into the editor's store.
                        // Enter on the row opens it, so the link is no Tab stop.
                        <Link
                          className="truncate rounded-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                          params={{ workflowId: workflow.id }}
                          preload={false}
                          tabIndex={-1}
                          title={workflow.name}
                          to="/workflows/$workflowId"
                        >
                          {workflow.name}
                        </Link>
                      ) : (
                        <span
                          className="truncate font-medium text-foreground"
                          title={workflow.name}
                        >
                          {workflow.name}
                        </span>
                      )}
                      {isOpening ? (
                        <Spinner
                          aria-label="Opening workflow"
                          className="size-3.5 text-muted-foreground"
                        />
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex items-center gap-3 md:hidden">
                      <WorkflowStateLabel workflow={workflow} />
                    </div>
                  </td>
                  <td className="hidden px-2 md:table-cell">
                    <WorkflowStateLabel workflow={workflow} />
                  </td>
                  <td className="hidden px-2 text-muted-foreground text-xs tabular-nums md:table-cell">
                    <time
                      dateTime={workflow.updatedAt}
                      title={formatExactTime(new Date(workflow.updatedAt))}
                    >
                      {getCompactRelativeTime(workflow.updatedAt)}
                    </time>
                  </td>
                  <td className="pr-3 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label={`Actions for ${workflow.name}`}
                        // Shift+F10 on the row opens this menu, which finds the
                        // trigger by this attribute.
                        data-row-menu=""
                        render={
                          <Button
                            className="text-muted-foreground"
                            size="icon-sm"
                            tabIndex={-1}
                            variant="ghost"
                          />
                        }
                      >
                        <MoreHorizontalIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canUpdate ? (
                          <DropdownMenuItem
                            disabled={setPublishedMode.isPending}
                            onClick={() => {
                              changePublishedMode(
                                workflow,
                                isTestMode ? "live" : "test"
                              );
                            }}
                          >
                            {isTestMode
                              ? "Set Published mode to Live"
                              : "Set Published mode to Test"}
                          </DropdownMenuItem>
                        ) : null}
                        {canBulkLifecycle && offersPauseToggle ? (
                          <DropdownMenuItem
                            disabled={lifecycleAction !== null}
                            onClick={() => {
                              runLifecycleAction(toggleAction, [workflow.id]);
                            }}
                          >
                            {toggleActionLabel}
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem
                          onClick={() => void copyWorkflowId(workflow.id)}
                        >
                          <Copy />
                          Copy workflow ID
                        </DropdownMenuItem>
                        {canBulkLifecycle ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={lifecycleAction !== null}
                              onClick={() => {
                                openDeleteConfirmation([workflow.id]);
                              }}
                              variant="destructive"
                            >
                              Delete
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="sr-only" id={workflowKeysHintId}>
          Use the arrow keys or J and K to move between workflows. Press Enter
          to open one, Space to select it, and Shift+F10 for its actions.
        </p>
      </>
    );
  };

  const runHistoryTableKey = `${runQuery}:${runFilters.map((filter) => filter.id).join(",")}`;
  const selectedCount = selectedActionableIds.length;

  return (
    // The page is one scroll surface below `xl`, where the two panels stack.
    // At `xl` they sit side by side and fill the viewport's height, and each
    // list scrolls inside its own panel.
    <div className="h-dvh overflow-auto bg-background xl:overflow-hidden">
      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-3 md:p-6 xl:h-full">
        <header className="flex min-h-8 flex-wrap items-center justify-between gap-3">
          <h1 className="font-semibold text-base text-foreground">Workflows</h1>
          <div className="flex flex-wrap items-center gap-2">
            <WorkflowsPagePalette
              onNewWorkflow={canCreate ? openCreateDialog : undefined}
              onOpenWorkflow={canOpenWorkflow ? openWorkflow : undefined}
              workflows={workflowRows}
            />
            {canCreate ? (
              <Button onClick={openCreateDialog} type="button">
                New workflow
              </Button>
            ) : null}
          </div>
        </header>

        <div className="grid grid-cols-1 gap-4 md:gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-2 xl:grid-rows-[minmax(0,1fr)]">
          {canReadWorkflows ? (
            <section
              aria-labelledby="all-workflows-heading"
              className="flex flex-col overflow-clip rounded-xl border bg-card xl:min-h-0"
            >
              {/* One header row in both states. While workflows are selected
                  the bulk actions take Refresh's place, so nothing below moves
                  and no red shows while nothing can be deleted. */}
              <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
                <h2
                  className="font-medium text-foreground text-sm"
                  id="all-workflows-heading"
                >
                  All Workflows
                  <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">
                    {selectedCount > 0
                      ? `${selectedCount} selected`
                      : workflowRows.length}
                  </span>
                </h2>
                {canBulkLifecycle && selectedCount > 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      disabled={lifecycleAction !== null}
                      onClick={() => {
                        runLifecycleAction("pause", selectedActionableIds);
                      }}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Pause
                    </Button>
                    <Button
                      disabled={lifecycleAction !== null}
                      onClick={() => {
                        runLifecycleAction("resume", selectedActionableIds);
                      }}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Resume
                    </Button>
                    <Button
                      disabled={lifecycleAction !== null}
                      onClick={() => {
                        openDeleteConfirmation(selectedActionableIds);
                      }}
                      size="sm"
                      type="button"
                      variant="destructive"
                    >
                      Delete
                    </Button>
                  </div>
                ) : (
                  <Button
                    disabled={
                      workflowsQuery.isFetching || lifecycleAction !== null
                    }
                    onClick={refreshWorkflows}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Refresh
                  </Button>
                )}
              </div>

              <div className="xl:min-h-0 xl:flex-1 xl:overflow-auto">
                {renderWorkflowContent()}
              </div>
            </section>
          ) : null}

          {canOpenGlobalRuns ? (
            // Below `xl` the panel takes a fixed share of the viewport, because
            // the run list is virtualized and needs a bounded scroller.
            <section
              aria-labelledby="all-runs-heading"
              className="flex h-[min(85dvh,48rem)] min-h-0 flex-col rounded-xl border bg-card xl:h-auto"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                <div>
                  <h2
                    className="font-medium text-foreground text-sm"
                    id="all-runs-heading"
                  >
                    All Runs
                  </h2>
                  <p className="text-muted-foreground text-xs">
                    Combined run history across workflows.
                  </p>
                  <RunRetentionNote
                    runRetentionMs={
                      runsQuery.data?.pages[0]?.runRetentionMs ?? null
                    }
                  />
                </div>
                <Button
                  disabled={isLoadingRuns || isLoadingMoreRuns}
                  onClick={() => {
                    void refreshRuns();
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Refresh
                </Button>
              </div>

              <div className="relative z-20 flex flex-col gap-2 border-b px-4 py-2">
                <RunHistorySearch
                  entitySuggestions={entitySuggestions}
                  eventSuggestions={eventSuggestions}
                  filters={runFilters}
                  loadedCount={runs.length}
                  onFiltersChange={setRunFilters}
                  onQueryChange={setRunQuery}
                  query={runQuery}
                  resultCount={visibleRuns.length}
                  workflows={workflowRows.map((workflow) => ({
                    id: workflow.id,
                    name: workflow.name,
                  }))}
                />
                {canBulkLifecycle ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      disabled={selectedActionableIds.length === 0}
                      onClick={() => {
                        setShowSelectedRunsOnly((prev) => !prev);
                      }}
                      size="sm"
                      type="button"
                      variant={showSelectedRunsOnly ? "secondary" : "outline"}
                    >
                      {showSelectedRunsOnly
                        ? "Showing selected workflows"
                        : "Show selected workflows only"}
                    </Button>
                  </div>
                ) : null}
              </div>

              <RunHistoryTable
                hasNextPage={runsQuery.hasNextPage}
                isLoading={isLoadingRuns}
                isLoadingMore={isLoadingMoreRuns}
                key={runHistoryTableKey}
                loadFailed={runsQuery.isError && runsQuery.data === undefined}
                onLoadMore={() => {
                  void runsQuery.fetchNextPage();
                }}
                onOpenRun={openRun}
                onRetry={() => {
                  void runsQuery.refetch();
                }}
                runs={visibleRuns}
              />
            </section>
          ) : null}
        </div>
      </main>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setConfirmDelete(null);
            setDeleteChallenge("");
          }
        }}
        open={confirmDelete !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmDelete?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmDelete && confirmDelete.workflowNames.length > 1 ? (
            <ul className="list-disc pl-5 text-muted-foreground text-sm">
              {confirmDelete.workflowIds.slice(0, 3).map((id, index) => (
                <li key={id}>{confirmDelete.workflowNames[index]}</li>
              ))}
              {confirmDelete.workflowNames.length > 3 ? (
                <li>and {confirmDelete.workflowNames.length - 3} more</li>
              ) : null}
            </ul>
          ) : null}
          {confirmDelete &&
          confirmDelete.workflowIds.length > DELETE_CHALLENGE_THRESHOLD ? (
            <div className="space-y-2">
              <Label htmlFor="delete-challenge">
                Type {confirmDelete.workflowIds.length} to confirm
              </Label>
              <Input
                autoComplete="off"
                id="delete-challenge"
                inputMode="numeric"
                onChange={(event) => {
                  setDeleteChallenge(event.target.value);
                }}
                value={deleteChallenge}
              />
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                confirmDelete !== null &&
                confirmDelete.workflowIds.length > DELETE_CHALLENGE_THRESHOLD &&
                deleteChallenge.trim() !==
                  String(confirmDelete.workflowIds.length)
              }
              onClick={() => {
                if (!confirmDelete) {
                  return;
                }

                runLifecycleAction("delete", confirmDelete.workflowIds);
                setConfirmDelete(null);
                setDeleteChallenge("");
              }}
              variant="destructive"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {canCreate ? (
        <CreateWorkflowDialog
          key={createDialogSession}
          existingWorkflowNames={workflows.map((workflow) => workflow.name)}
          onCreated={(workflowId) =>
            navigate({ to: "/workflows/$workflowId", params: { workflowId } })
          }
          onOpenChange={setIsCreateDialogOpen}
          open={isCreateDialogOpen}
        />
      ) : null}
    </div>
  );
}
