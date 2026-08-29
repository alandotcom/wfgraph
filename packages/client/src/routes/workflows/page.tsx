import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Circle, MoreHorizontalIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmOverlay } from "#src/components/overlays/confirm-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { getClientLogger } from "#src/lib/logger";
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
import { RunHistorySearch } from "#src/components/workflows/run-history-search";
import { RunHistoryTable } from "#src/components/workflows/run-history-table";
import type { WorkflowExecutionsGlobalResult } from "#src/lib/rpc-client";
import type { WorkflowSummaryPayload } from "@wfgraph/shared/graph/api-contracts";
import {
  filterRuns,
  toExecutionsQueryInput,
  uniqueNonEmpty,
  type RunFilter,
} from "#src/lib/run-history-filters";
import {
  orpcQuery,
  refreshRunHistory,
  refreshWorkflowList,
} from "#src/lib/rpc-query";
import type { WorkflowMode } from "#src/lib/workflow-graph-types";
import { getRelativeTime } from "@wfgraph/shared/utils/time";

type GlobalExecutionItem = WorkflowExecutionsGlobalResult["items"][number];

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

export default function WorkflowsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useOverlay();
  const [selectedWorkflowIds, setSelectedWorkflowIds] = useState<Set<string>>(
    new Set()
  );
  const [runFilters, setRunFilters] = useState<RunFilter[]>([]);
  const [runQuery, setRunQuery] = useState("");
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

  const { data: workflows = [], isPending: isLoadingWorkflows } = useQuery(
    orpcQuery.workflow.getAll.queryOptions({
      input: {},
      select: toSortedWorkflows,
      meta: { errorMessage: "Failed to load workflows" },
    })
  );

  const workflowRows = useMemo(
    () => workflows.filter((workflow) => workflow.name !== "__current__"),
    [workflows]
  );

  const selectedIds = useMemo(
    () => Array.from(selectedWorkflowIds),
    [selectedWorkflowIds]
  );

  const selectedActionableIds = useMemo(
    () =>
      selectedIds.filter((workflowId) =>
        workflowRows.some(
          (workflow) => workflow.id === workflowId && workflow.isOwner !== false
        )
      ),
    [selectedIds, workflowRows]
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
  const runsQuery = useInfiniteQuery(
    orpcQuery.workflow.getExecutionsGlobal.infiniteOptions({
      input: (cursor: RunsCursor | undefined) => ({ ...runsFilter, cursor }),
      initialPageParam: undefined as RunsCursor | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      meta: { errorMessage: "Failed to load workflow runs" },
    })
  );

  const runs: GlobalExecutionItem[] = useMemo(
    () => runsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [runsQuery.data]
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

  // The write is addressed to the row it was chosen on, so nothing here touches
  // the editor's open-workflow atoms: those name which workflow the canvas is
  // showing, and `hydrateWorkflowAtom` treats a matching id as a reload of the
  // same workflow and keeps the pinned run, the comparison session and the
  // workspace view it would otherwise clear.
  const setPublishedMode = useMutation(
    orpcQuery.workflow.update.mutationOptions({
      // The "Sends to" cell this table is showing is the answer to the setting
      // being written, and this table is mounted while the write lands, so the
      // list is refetched rather than merely marked stale.
      onSuccess: async (_payload, { mode }) => {
        await refreshWorkflowList(queryClient);
        toast.success(
          mode === "test"
            ? "Published mode set to Test"
            : "Published mode set to Live"
        );
      },
      meta: { errorMessage: "Failed to set Published mode" },
    })
  );

  const writePublishedMode = setPublishedMode.mutate;
  // Live-ward asks first, wherever it is offered: it is the moment a workflow
  // starts sending to real people. Test-ward can only narrow who a run reaches,
  // so it writes on one press. The dashboard's list payload carries no version
  // number, so the question names the setting's subject rather than inventing
  // one.
  const changePublishedMode = useCallback(
    (workflow: WorkflowSummaryPayload, mode: WorkflowMode) => {
      if (workflow.mode === mode) {
        return;
      }

      if (mode === "test") {
        writePublishedMode({ workflowId: workflow.id, mode: "test" });
        return;
      }

      push(ConfirmOverlay, {
        title: `Send real messages from ${workflow.name}?`,
        message:
          "Events and manual runs of the published version will reach real recipients.",
        confirmLabel: "Send real messages",
        destructive: true,
        onConfirm: () => {
          writePublishedMode({ workflowId: workflow.id, mode: "live" });
        },
      });
    },
    [push, writePublishedMode]
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

  const openRun = useCallback(
    (item: GlobalExecutionItem) => {
      void navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: item.workflowId },
        search: { executionId: item.id },
      });
    },
    [navigate]
  );

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
      if (workflowIds.length === 0) {
        return;
      }
      runLifecycle({ workflowIds, action });
    },
    [runLifecycle]
  );

  const openDeleteConfirmation = useCallback(
    (workflowIds: string[]) => {
      if (workflowIds.length === 0) {
        return;
      }

      const namesById = new Map(
        workflows.map((workflow) => [workflow.id, workflow.name])
      );
      const workflowNames = workflowIds.map(
        (id) => namesById.get(id) ?? "Untitled workflow"
      );

      const title =
        workflowIds.length === 1 ? "Delete Workflow" : "Delete Workflows";
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
    [workflows]
  );

  const renderWorkflowContent = () => {
    if (isLoadingWorkflows && workflowRows.length === 0) {
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

    return (
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b">
            <th className="w-10 px-4 py-2">
              <Checkbox
                aria-label="Select all workflows"
                checked={allSelected}
                onCheckedChange={(checked) => {
                  toggleSelectAll(checked);
                }}
              />
            </th>
            <th className="px-2 py-2">Name</th>
            <th className="px-2 py-2">State</th>
            <th className="px-2 py-2">Sends to</th>
            <th className="px-2 py-2">Updated</th>
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {workflowRows.map((workflow) => {
            const isSelected = selectedWorkflowIds.has(workflow.id);
            const canMutate = workflow.isOwner !== false;
            // Whether the workflow is switched off is a graphite fact with a
            // green dot for the live case: Signal Amber belongs to Test alone,
            // and this row is the one screen showing both facts at once, three
            // columns apart at the same 12px.
            const stateDotClass = workflow.isPaused
              ? "text-muted-foreground"
              : "text-success fill-current";
            const stateLabel = workflow.isPaused ? "Paused" : "Active";
            const isTestOnly = workflow.mode === "test";
            // The dot repeats the status strip's Published mode vocabulary,
            // filled for Test and outline for Live. The signal carries the
            // border and the label rather than a fill behind them: each light
            // token clears 4.5:1 as text on Paper and falls under it on its own
            // 10% tint, which is under the floor at Caption size.
            const sendsToClass = isTestOnly
              ? "border-warning/40 text-warning"
              : "border-border text-muted-foreground";
            const sendsToLabel = isTestOnly ? "Test only" : "Real people";
            const toggleAction = workflow.isPaused ? "resume" : "pause";
            const toggleActionLabel = workflow.isPaused ? "Resume" : "Pause";

            return (
              <tr className="border-b last:border-b-0" key={workflow.id}>
                <td className="px-4 py-3">
                  <Checkbox
                    aria-label={`Select ${workflow.name}`}
                    checked={isSelected}
                    onCheckedChange={(checked) => {
                      toggleSelectOne(workflow.id, checked);
                    }}
                  />
                </td>
                <td className="px-2 py-3">
                  <button
                    className="text-left font-medium text-foreground hover:underline"
                    onClick={() => {
                      void navigate({
                        to: "/workflows/$workflowId",
                        params: { workflowId: workflow.id },
                      });
                    }}
                    type="button"
                  >
                    {workflow.name}
                  </button>
                  <div className="font-mono text-muted-foreground text-xs">
                    {workflow.id}
                  </div>
                </td>
                <td className="px-2 py-3">
                  {/* A dot and a word, with no pill around them: the row's one
                      bordered chip is "Sends to", which is the cell an operator
                      is scanning for. */}
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-medium text-foreground text-xs">
                    <Circle
                      aria-hidden
                      className={`size-2.5 transition-colors duration-200 ${stateDotClass}`}
                    />
                    {stateLabel}
                  </span>
                </td>
                <td className="px-2 py-3">
                  <span
                    className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded border px-2 py-0.5 font-medium text-xs transition-colors duration-200 ${sendsToClass}`}
                  >
                    <Circle
                      aria-hidden
                      className={`size-2.5 ${isTestOnly ? "fill-current" : ""}`}
                    />
                    {sendsToLabel}
                  </span>
                </td>
                <td className="px-2 py-3 text-muted-foreground text-xs">
                  {getRelativeTime(workflow.updatedAt)}
                </td>
                <td className="px-2 py-3">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      className="inline-flex size-8 items-center justify-center rounded-md border border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                      disabled={!canMutate || lifecycleAction !== null}
                    >
                      <MoreHorizontalIcon className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={setPublishedMode.isPending}
                        onClick={() => {
                          changePublishedMode(
                            workflow,
                            isTestOnly ? "live" : "test"
                          );
                        }}
                      >
                        {isTestOnly
                          ? "Set published mode to Live"
                          : "Set published mode to Test"}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          runLifecycleAction(toggleAction, [workflow.id]);
                        }}
                      >
                        {toggleActionLabel}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => {
                          openDeleteConfirmation([workflow.id]);
                        }}
                        variant="destructive"
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  };

  const runHistoryTableKey = `${runQuery}:${runFilters.map((filter) => filter.id).join(",")}`;

  return (
    <div className="h-dvh overflow-auto bg-background">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-6">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="font-semibold text-2xl text-foreground">
              Workflow Dashboard
            </h1>
            <Button
              onClick={() => {
                setCreateDialogSession((session) => session + 1);
                setIsCreateDialogOpen(true);
              }}
              type="button"
            >
              New Workflow
            </Button>
          </div>
          <p className="text-muted-foreground text-sm">
            Manage workflows in bulk and review runs across every workflow.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_1.5fr]">
          <section className="rounded-xl border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
              <div>
                <h2 className="font-medium text-foreground text-sm">
                  Workflows
                </h2>
                <p className="text-muted-foreground text-xs">
                  Select one or more workflows to run bulk actions.
                </p>
              </div>
              <Button
                disabled={isLoadingWorkflows || lifecycleAction !== null}
                onClick={refreshWorkflows}
                size="sm"
                type="button"
                variant="outline"
              >
                Refresh
              </Button>
            </div>

            <div className="border-b px-4 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={
                    selectedActionableIds.length === 0 ||
                    lifecycleAction !== null
                  }
                  onClick={() => {
                    runLifecycleAction("pause", selectedActionableIds);
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Pause Selected
                </Button>
                <Button
                  disabled={
                    selectedActionableIds.length === 0 ||
                    lifecycleAction !== null
                  }
                  onClick={() => {
                    runLifecycleAction("resume", selectedActionableIds);
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Resume Selected
                </Button>
                <Button
                  disabled={
                    selectedActionableIds.length === 0 ||
                    lifecycleAction !== null
                  }
                  onClick={() => {
                    openDeleteConfirmation(selectedActionableIds);
                  }}
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  Delete Selected
                </Button>
              </div>
            </div>

            <div className="max-h-[65vh] overflow-auto">
              {renderWorkflowContent()}
            </div>
          </section>

          <section className="rounded-xl border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
              <div>
                <h2 className="font-medium text-foreground text-sm">
                  All Runs
                </h2>
                <p className="text-muted-foreground text-xs">
                  Combined run history across workflows.
                </p>
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
            </div>

            <RunHistoryTable
              hasNextPage={runsQuery.hasNextPage}
              isLoading={isLoadingRuns}
              isLoadingMore={isLoadingMoreRuns}
              key={runHistoryTableKey}
              onLoadMore={() => {
                void runsQuery.fetchNextPage();
              }}
              onOpenRun={openRun}
              runs={visibleRuns}
            />
          </section>
        </div>
      </div>

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
      <CreateWorkflowDialog
        key={createDialogSession}
        existingWorkflowNames={workflows.map((workflow) => workflow.name)}
        onCreated={(workflowId) =>
          navigate({ to: "/workflows/$workflowId", params: { workflowId } })
        }
        onOpenChange={setIsCreateDialogOpen}
        open={isCreateDialogOpen}
      />
    </div>
  );
}
