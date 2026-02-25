import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
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
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CreateWorkflowDialog } from "@/components/workflow/create-workflow-dialog";
import { api, type SavedWorkflow } from "@/lib/rpc-client";
import { getRelativeTime } from "@/shared/utils/time";

type WorkflowExecutionStatus =
  | "pending"
  | "running"
  | "waiting"
  | "success"
  | "error"
  | "cancelled";

type GlobalExecutionItem = Awaited<
  ReturnType<typeof api.workflow.getExecutionsGlobal>
>["items"][number];

type RunsCursor = {
  startedAt: string;
  id: string;
};

type ConfirmDeleteState = {
  workflowIds: string[];
  title: string;
  description: string;
};

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
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([]);
  const [runs, setRuns] = useState<GlobalExecutionItem[]>([]);
  const [runsCursor, setRunsCursor] = useState<RunsCursor | null>(null);
  const [selectedWorkflowIds, setSelectedWorkflowIds] = useState<Set<string>>(
    new Set()
  );
  const [statusFilters, setStatusFilters] = useState<
    Set<WorkflowExecutionStatus>
  >(new Set());
  const [showSelectedRunsOnly, setShowSelectedRunsOnly] = useState(false);
  const [isLoadingWorkflows, setIsLoadingWorkflows] = useState(true);
  const [isLoadingRuns, setIsLoadingRuns] = useState(true);
  const [isLoadingMoreRuns, setIsLoadingMoreRuns] = useState(false);
  const [lifecycleAction, setLifecycleAction] = useState<
    "pause" | "resume" | "delete" | null
  >(null);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ConfirmDeleteState | null>(
    null
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

  const allSelected =
    workflowRows.length > 0 && selectedWorkflowIds.size === workflowRows.length;

  const hasSelectedRunsFilter =
    showSelectedRunsOnly && selectedActionableIds.length > 0;

  const loadWorkflows = useCallback(async () => {
    setIsLoadingWorkflows(true);
    try {
      const all = await api.workflow.getAll();
      setWorkflows(all.toSorted(byUpdatedDesc));

      setSelectedWorkflowIds((prev) => {
        const existingIds = new Set(all.map((workflow) => workflow.id));
        const next = new Set<string>();
        for (const id of prev) {
          if (existingIds.has(id)) {
            next.add(id);
          }
        }
        return next;
      });
    } catch (error) {
      console.error("Failed to load workflows:", error);
      toast.error("Failed to load workflows");
    } finally {
      setIsLoadingWorkflows(false);
    }
  }, []);

  const loadRuns = useCallback(
    async (cursor?: RunsCursor) => {
      const selectedStatuses = Array.from(statusFilters);

      if (cursor) {
        setIsLoadingMoreRuns(true);
      } else {
        setIsLoadingRuns(true);
      }

      try {
        const response = await api.workflow.getExecutionsGlobal({
          workflowIds: hasSelectedRunsFilter
            ? selectedActionableIds
            : undefined,
          statuses: selectedStatuses.length > 0 ? selectedStatuses : undefined,
          limit: 100,
          cursor,
        });

        setRuns((prev) =>
          cursor ? [...prev, ...response.items] : response.items
        );
        setRunsCursor(response.nextCursor);
      } catch (error) {
        console.error("Failed to load workflow runs:", error);
        toast.error("Failed to load workflow runs");
      } finally {
        if (cursor) {
          setIsLoadingMoreRuns(false);
        } else {
          setIsLoadingRuns(false);
        }
      }
    },
    [hasSelectedRunsFilter, selectedActionableIds, statusFilters]
  );

  useEffect(() => {
    loadWorkflows();
  }, [loadWorkflows]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

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

  const runLifecycleAction = useCallback(
    async (action: "pause" | "resume" | "delete", workflowIds: string[]) => {
      if (workflowIds.length === 0) {
        return;
      }

      setLifecycleAction(action);
      try {
        const result = await api.workflow.bulkLifecycle({
          workflowIds,
          action,
        });

        if (result.summary.failed === 0) {
          toast.success(
            `${getCompletedActionLabel(action)} ${result.summary.succeeded} workflow${pluralize(result.summary.succeeded, "", "s")}`
          );
        } else {
          toast.error(
            `${action} finished with ${result.summary.failed} failure${pluralize(result.summary.failed, "", "s")}`
          );
        }

        if (action === "delete") {
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

          setWorkflows((prev) => prev.filter((w) => !deletedIds.has(w.id)));
        }

        await loadWorkflows();

        if (action === "delete") {
          await loadRuns();
        }
      } catch (error) {
        console.error(`Failed to ${action} workflows:`, error);
        toast.error(`Failed to ${action} workflows`);
      } finally {
        setLifecycleAction(null);
      }
    },
    [loadRuns, loadWorkflows]
  );

  const openDeleteConfirmation = useCallback((workflowIds: string[]) => {
    if (workflowIds.length === 0) {
      return;
    }

    const title =
      workflowIds.length === 1 ? "Delete Workflow" : "Delete Workflows";
    const description =
      workflowIds.length === 1
        ? "This will permanently delete the workflow and all related runs/events. This cannot be undone."
        : `This will permanently delete ${workflowIds.length} workflows and all related runs/events. This cannot be undone.`;

    setConfirmDelete({
      workflowIds,
      title,
      description,
    });
  }, []);

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
            <th className="px-4 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {/* biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Row rendering includes per-item state/mode/action controls and is clearer in a single map callback. */}
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
                      navigate({
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
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <Button
                      disabled={!canMutate || lifecycleAction !== null}
                      onClick={async () => {
                        try {
                          const nextMode =
                            workflow.mode === "test" ? "live" : "test";
                          const updatedWorkflow = await api.workflow.update(
                            workflow.id,
                            {
                              mode: nextMode,
                            }
                          );
                          setWorkflows((current) =>
                            current.map((item) =>
                              item.id === updatedWorkflow.id
                                ? { ...item, ...updatedWorkflow }
                                : item
                            )
                          );
                          toast.success(
                            nextMode === "test"
                              ? "Switched workflow to Test mode"
                              : "Switched workflow to Live mode"
                          );
                        } catch (error) {
                          console.error(
                            "Failed to switch workflow mode:",
                            error
                          );
                          toast.error("Failed to switch workflow mode");
                        }
                      }}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {workflow.mode === "test"
                        ? "Switch to Live"
                        : "Switch to Test"}
                    </Button>
                    <Button
                      disabled={!canMutate || lifecycleAction !== null}
                      onClick={() => {
                        runLifecycleAction(toggleAction, [workflow.id]);
                      }}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {toggleActionLabel}
                    </Button>
                    <Button
                      disabled={!canMutate || lifecycleAction !== null}
                      onClick={() => {
                        openDeleteConfirmation([workflow.id]);
                      }}
                      size="sm"
                      type="button"
                      variant="destructive"
                    >
                      Delete
                    </Button>
                  </div>
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
            <th className="px-2 py-2">Trigger</th>
            <th className="px-2 py-2">Mode</th>
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
                {run.triggerType ?? "-"}
                {run.triggerEventType ? ` / ${run.triggerEventType}` : ""}
              </td>
              <td className="px-2 py-3 text-muted-foreground text-xs">
                {run.runMode === "test" ? (
                  <span className="rounded border border-destructive/30 bg-destructive/10 px-2 py-0.5 font-medium text-[10px] text-destructive uppercase">
                    Test
                  </span>
                ) : (
                  <span className="rounded border border-zinc-500/30 bg-zinc-500/10 px-2 py-0.5 font-medium text-[10px] text-zinc-700 uppercase">
                    Live
                  </span>
                )}
              </td>
              <td className="px-2 py-3 text-muted-foreground text-xs">
                {formatDuration(run.duration)}
              </td>
              <td className="px-4 py-3 text-right">
                <Button
                  onClick={() => {
                    navigate({
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

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.1fr_1.6fr]">
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
                onClick={loadWorkflows}
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
                  loadRuns();
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

            {runsCursor ? (
              <div className="border-t px-4 py-3">
                <Button
                  disabled={isLoadingMoreRuns}
                  onClick={() => {
                    if (runsCursor) {
                      loadRuns(runsCursor);
                    }
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
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!confirmDelete) {
                  return;
                }

                runLifecycleAction("delete", confirmDelete.workflowIds).finally(
                  () => {
                    setConfirmDelete(null);
                  }
                );
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <CreateWorkflowDialog
        existingWorkflowNames={workflows.map((workflow) => workflow.name)}
        onCreated={async (createdWorkflow) => {
          await Promise.all([loadWorkflows(), loadRuns()]);
          await navigate({
            to: "/workflows/$workflowId",
            params: { workflowId: createdWorkflow.id },
          });
        }}
        onOpenChange={setIsCreateDialogOpen}
        open={isCreateDialogOpen}
      />
    </div>
  );
}
