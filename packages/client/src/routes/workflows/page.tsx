import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { isNil, omitBy } from "es-toolkit";
import { MoreHorizontalIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
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
import {
  type SavedWorkflow,
  toSavedWorkflows,
  type WorkflowExecutionsGlobalResult,
} from "#src/lib/rpc-client";
import {
  orpcQuery,
  refreshRunHistory,
  refreshWorkflowList,
} from "#src/lib/rpc-query";
import { getRelativeTime } from "@rova/shared/utils/time";

type WorkflowExecutionStatus =
  | "pending"
  | "running"
  | "waiting"
  | "success"
  | "error"
  | "cancelled";

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
const DELETE_CHALLENGE_THRESHOLD = 3;

const STATUS_OPTIONS: WorkflowExecutionStatus[] = [
  "running",
  "waiting",
  "error",
  "success",
  "cancelled",
  "pending",
];

function getStatusBadgeClass(status: WorkflowExecutionStatus): string {
  switch (status) {
    case "running":
      return "border-blue-500/30 bg-blue-500/10 text-blue-700";
    case "waiting":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700";
    case "success":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700";
    case "error":
      return "border-red-500/30 bg-red-500/10 text-red-700";
    case "cancelled":
      return "border-slate-500/30 bg-slate-500/10 text-slate-700";
    case "pending":
      return "border-zinc-500/30 bg-zinc-500/10 text-zinc-700";
    default:
      return "border-zinc-500/30 bg-zinc-500/10 text-zinc-700";
  }
}

function formatDuration(duration: string | null): string {
  if (!duration) {
    return "-";
  }

  const durationMs = Number.parseInt(duration, 10);
  if (Number.isNaN(durationMs)) {
    return duration;
  }

  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(2)}s`;
}

/** One page of runs. The list is long enough that it is paged, not sliced. */
const RUNS_PAGE_SIZE = 100;

/**
 * Newest first. A module-level function so TanStack can memoise the select by
 * identity instead of deserialising and re-sorting on every render.
 */
function toSortedWorkflows(
  payload: Parameters<typeof toSavedWorkflows>[0]
): SavedWorkflow[] {
  return toSavedWorkflows(payload).toSorted(byUpdatedDesc);
}

function byUpdatedDesc(a: SavedWorkflow, b: SavedWorkflow): number {
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
  const [selectedWorkflowIds, setSelectedWorkflowIds] = useState<Set<string>>(
    new Set()
  );
  const [statusFilters, setStatusFilters] = useState<
    Set<WorkflowExecutionStatus>
  >(new Set());
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
      omitBy(
        {
          workflowIds: hasSelectedRunsFilter
            ? selectedActionableIds.toSorted()
            : undefined,
          statuses:
            statusFilters.size > 0
              ? Array.from(statusFilters).toSorted()
              : undefined,
          limit: RUNS_PAGE_SIZE,
        },
        isNil
      ),
    [hasSelectedRunsFilter, selectedActionableIds, statusFilters]
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

  const switchMode = useMutation(
    orpcQuery.workflow.update.mutationOptions({
      onSuccess: async (_payload, { mode }) => {
        await refreshWorkflows();
        toast.success(
          mode === "test"
            ? "Switched workflow to Test mode"
            : "Switched workflow to Live mode"
        );
      },
      meta: { errorMessage: "Failed to switch workflow mode" },
    })
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

  const toggleStatusFilter = (status: WorkflowExecutionStatus) => {
    setStatusFilters((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
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
        console.error(`Failed to ${action} workflows:`, error);
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
            <th className="px-2 py-2">Mode</th>
            <th className="px-2 py-2">Updated</th>
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {workflowRows.map((workflow) => {
            const isSelected = selectedWorkflowIds.has(workflow.id);
            const canMutate = workflow.isOwner !== false;
            const stateClass = workflow.isPaused
              ? "border-amber-500/30 bg-amber-500/10 text-amber-700"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700";
            const stateLabel = workflow.isPaused ? "Paused" : "Active";
            const modeClass =
              workflow.mode === "test"
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-zinc-500/30 bg-zinc-500/10 text-zinc-700";
            const modeLabel = workflow.mode === "test" ? "Test" : "Live";
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
                  <span
                    className={`inline-flex rounded border px-2 py-0.5 font-medium text-xs transition-colors duration-200 ${stateClass}`}
                  >
                    {stateLabel}
                  </span>
                </td>
                <td className="px-2 py-3">
                  <span
                    className={`inline-flex rounded border px-2 py-0.5 font-medium text-xs uppercase transition-colors duration-200 ${modeClass}`}
                  >
                    {modeLabel}
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
                        onClick={() => {
                          switchMode.mutate({
                            workflowId: workflow.id,
                            mode: workflow.mode === "test" ? "live" : "test",
                          });
                        }}
                      >
                        {workflow.mode === "test"
                          ? "Switch to Live"
                          : "Switch to Test"}
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

  const renderRunsContent = () => {
    if (isLoadingRuns && runs.length === 0) {
      return (
        <div className="p-6 text-muted-foreground text-sm">Loading runs...</div>
      );
    }

    if (runs.length === 0) {
      return (
        <div className="p-6 text-muted-foreground text-sm">No runs found.</div>
      );
    }

    return (
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b">
            <th className="px-4 py-2">Workflow</th>
            <th className="px-2 py-2">Status</th>
            <th className="px-2 py-2">Started</th>
            <th className="px-2 py-2">Duration</th>
            <th className="px-4 py-2 text-right">Open</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr className="border-b last:border-b-0" key={run.id}>
              <td className="px-4 py-3">
                <div className="font-medium text-foreground text-sm">
                  {run.workflowName}
                </div>
                <div className="font-mono text-muted-foreground text-xs">
                  {run.workflowId}
                </div>
              </td>
              <td className="px-2 py-3">
                <span
                  className={`inline-flex rounded border px-2 py-0.5 font-medium text-xs uppercase ${getStatusBadgeClass(run.status)}`}
                >
                  {run.status}
                </span>
              </td>
              <td className="px-2 py-3 text-muted-foreground text-xs">
                {getRelativeTime(run.startedAt)}
              </td>
              <td className="px-2 py-3 text-muted-foreground text-xs">
                {formatDuration(run.duration)}
              </td>
              <td className="px-4 py-3 text-right">
                <Button
                  onClick={() => {
                    void navigate({
                      to: "/workflows/$workflowId",
                      params: { workflowId: run.workflowId },
                    });
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Open
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  return (
    <div className="pointer-events-auto h-dvh overflow-auto bg-background">
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
            Paused workflows block new starts. Test mode makes runs execute with
            test-mode action behavior.
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

            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
              <Button
                onClick={() => {
                  setStatusFilters(new Set());
                }}
                size="sm"
                type="button"
                variant={statusFilters.size === 0 ? "secondary" : "outline"}
              >
                All statuses
              </Button>
              {STATUS_OPTIONS.map((status) => (
                <Button
                  key={status}
                  onClick={() => {
                    toggleStatusFilter(status);
                  }}
                  size="sm"
                  type="button"
                  variant={statusFilters.has(status) ? "secondary" : "outline"}
                >
                  {status}
                </Button>
              ))}
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

            <div className="max-h-[65vh] overflow-auto">
              {renderRunsContent()}
            </div>

            {runsQuery.hasNextPage ? (
              <div className="border-t px-4 py-3">
                <Button
                  disabled={isLoadingMoreRuns}
                  onClick={() => {
                    void runsQuery.fetchNextPage();
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {isLoadingMoreRuns ? "Loading..." : "Load more"}
                </Button>
              </div>
            ) : null}
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
