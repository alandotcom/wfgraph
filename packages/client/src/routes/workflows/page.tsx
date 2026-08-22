import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { isNil, omitBy } from "es-toolkit";
import { MoreHorizontal } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { notifications as toast } from "#src/lib/notifications";
import { getClientLogger } from "#src/lib/logger";
import { CreateWorkflowDialog } from "#src/components/workflow/create-workflow-dialog";
import type { WorkflowExecutionsGlobalResult } from "#src/lib/rpc-client";
import type { WorkflowSummaryPayload } from "@wfgraph/shared/graph/api-contracts";
import {
  orpcQuery,
  refreshRunHistory,
  refreshWorkflowList,
} from "#src/lib/rpc-query";
import type { WorkflowExecutionStatus } from "@wfgraph/shared/lifecycle/execution-contracts";
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

/**
 * The statuses this list offers as filters, and the ones it asks for when nothing
 * is ticked.
 *
 * `superseded` is a filter a builder can tick but never part of the default set: a
 * newest-wins workflow produces one on every reschedule, and unticked they would
 * bury the rows someone came to read. The editor's own runs panel says how many
 * there are per workflow.
 */
const DEFAULT_STATUS_OPTIONS: WorkflowExecutionStatus[] = [
  "running",
  "waiting",
  "failed",
  "completed",
  "canceled",
  "pending",
];

const STATUS_OPTIONS: WorkflowExecutionStatus[] = [
  ...DEFAULT_STATUS_OPTIONS,
  "superseded",
];

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

function getRunTokenColor(
  status: WorkflowExecutionStatus
): "blue" | "gray" | "green" | "red" | "yellow" {
  if (status === "failed" || status === "canceled") {
    return "red";
  }
  if (status === "completed") {
    return "green";
  }
  if (status === "running" || status === "waiting") {
    return "blue";
  }
  if (status === "pending") {
    return "yellow";
  }
  return "gray";
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
          // With no filter ticked the list asks for everything except superseded
          // runs, rather than for everything: a newest-wins workflow makes one on
          // every reschedule and they would bury the rest.
          statuses:
            statusFilters.size > 0
              ? Array.from(statusFilters).toSorted()
              : DEFAULT_STATUS_OPTIONS.toSorted(),
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
        <HStack align="center" gap={2} padding={6}>
          <Spinner size="sm" />
          <Text color="secondary">Loading workflows...</Text>
        </HStack>
      );
    }

    if (workflowRows.length === 0) {
      return (
        <EmptyState
          description="Create a workflow to start building and reviewing runs."
          headingLevel={3}
          isCompact
          title="No workflows yet"
        />
      );
    }

    return (
      <Table
        density="compact"
        dividers="rows"
        hasHover
        xstyle={styles.workflowTable}
      >
        <thead>
          <TableRow isHeaderRow>
            <TableHeaderCell xstyle={styles.selectionCell}>
              <CheckboxInput
                isLabelHidden
                label="Select all workflows"
                onChange={(checked) => {
                  toggleSelectAll(checked);
                }}
                size="sm"
                value={allSelected}
              />
            </TableHeaderCell>
            <TableHeaderCell xstyle={styles.workflowNameCell}>
              Name
            </TableHeaderCell>
            <TableHeaderCell xstyle={styles.stateCell}>State</TableHeaderCell>
            <TableHeaderCell xstyle={styles.modeCell}>Mode</TableHeaderCell>
            <TableHeaderCell xstyle={styles.updatedCell}>
              Updated
            </TableHeaderCell>
            <TableHeaderCell xstyle={styles.actionsCell}>
              Actions
            </TableHeaderCell>
          </TableRow>
        </thead>
        <tbody>
          {workflowRows.map((workflow) => {
            const isSelected = selectedWorkflowIds.has(workflow.id);
            const canMutate = workflow.isOwner !== false;
            const stateLabel = workflow.isPaused ? "Paused" : "Active";
            const modeLabel = workflow.mode === "test" ? "Test" : "Live";
            const toggleAction = workflow.isPaused ? "resume" : "pause";
            const toggleActionLabel = workflow.isPaused ? "Resume" : "Pause";

            return (
              <TableRow key={workflow.id}>
                <TableCell xstyle={styles.selectionCell}>
                  <CheckboxInput
                    isLabelHidden
                    label={`Select ${workflow.name}`}
                    onChange={(checked) => {
                      toggleSelectOne(workflow.id, checked);
                    }}
                    size="sm"
                    value={isSelected}
                  />
                </TableCell>
                <TableCell xstyle={styles.workflowNameCell}>
                  <VStack gap={0.5}>
                    <Button
                      label={workflow.name}
                      onClick={() => {
                        void navigate({
                          to: "/workflows/$workflowId",
                          params: { workflowId: workflow.id },
                        });
                      }}
                      size="sm"
                      variant="ghost"
                    />
                    <Text color="secondary" type="supporting">
                      {workflow.id}
                    </Text>
                  </VStack>
                </TableCell>
                <TableCell xstyle={styles.stateCell}>
                  <Token
                    color={workflow.isPaused ? "yellow" : "green"}
                    label={stateLabel}
                    size="sm"
                  />
                </TableCell>
                <TableCell xstyle={styles.modeCell}>
                  <Token
                    color={workflow.mode === "test" ? "red" : "gray"}
                    label={modeLabel}
                    size="sm"
                  />
                </TableCell>
                <TableCell xstyle={styles.updatedCell}>
                  <Text color="secondary" type="supporting">
                    {getRelativeTime(workflow.updatedAt)}
                  </Text>
                </TableCell>
                <TableCell xstyle={styles.actionsCell}>
                  <DropdownMenu
                    alignment="end"
                    button={{
                      icon: <Icon icon={MoreHorizontal} size="sm" />,
                      isDisabled: !canMutate || lifecycleAction !== null,
                      isIconOnly: true,
                      label: `Actions for ${workflow.name}`,
                      variant: "ghost",
                    }}
                    items={[
                      {
                        label:
                          workflow.mode === "test"
                            ? "Switch to Live"
                            : "Switch to Test",
                        onClick: () => {
                          switchMode.mutate({
                            workflowId: workflow.id,
                            mode: workflow.mode === "test" ? "live" : "test",
                          });
                        },
                      },
                      {
                        label: toggleActionLabel,
                        onClick: () => {
                          runLifecycleAction(toggleAction, [workflow.id]);
                        },
                      },
                      { type: "divider" },
                      {
                        label: "Delete",
                        onClick: () => {
                          openDeleteConfirmation([workflow.id]);
                        },
                        variant: "destructive",
                      },
                    ]}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </tbody>
      </Table>
    );
  };

  const renderRunsContent = () => {
    if (isLoadingRuns && runs.length === 0) {
      return (
        <HStack align="center" gap={2} padding={6}>
          <Spinner size="sm" />
          <Text color="secondary">Loading runs...</Text>
        </HStack>
      );
    }

    if (runs.length === 0) {
      return (
        <EmptyState
          description="Runs matching the current filters will appear here."
          headingLevel={3}
          isCompact
          title="No runs found"
        />
      );
    }

    return (
      <Table
        density="compact"
        dividers="rows"
        hasHover
        xstyle={styles.runsTable}
      >
        <thead>
          <TableRow isHeaderRow>
            <TableHeaderCell xstyle={styles.runWorkflowCell}>
              Workflow
            </TableHeaderCell>
            <TableHeaderCell xstyle={styles.runStatusCell}>
              Status
            </TableHeaderCell>
            <TableHeaderCell xstyle={styles.runStartedCell}>
              Started
            </TableHeaderCell>
            <TableHeaderCell xstyle={styles.runDurationCell}>
              Duration
            </TableHeaderCell>
            <TableHeaderCell xstyle={styles.runOpenCell}>Open</TableHeaderCell>
          </TableRow>
        </thead>
        <tbody>
          {runs.map((run) => (
            <TableRow key={run.id}>
              <TableCell xstyle={styles.runWorkflowCell}>
                <VStack gap={0.5}>
                  <Text weight="medium">{run.workflowName}</Text>
                  <Text color="secondary" type="supporting">
                    {run.workflowId}
                  </Text>
                </VStack>
              </TableCell>
              <TableCell xstyle={styles.runStatusCell}>
                <Token
                  color={getRunTokenColor(run.status)}
                  label={run.status}
                  size="sm"
                />
              </TableCell>
              <TableCell xstyle={styles.runStartedCell}>
                <Text color="secondary" type="supporting">
                  {getRelativeTime(run.startedAt)}
                </Text>
              </TableCell>
              <TableCell xstyle={styles.runDurationCell}>
                <Text color="secondary" type="supporting">
                  {formatDuration(run.duration)}
                </Text>
              </TableCell>
              <TableCell xstyle={styles.runOpenCell}>
                <Button
                  label="Open"
                  onClick={() => {
                    void navigate({
                      to: "/workflows/$workflowId",
                      params: { workflowId: run.workflowId },
                      search: { executionId: run.id },
                    });
                  }}
                  size="sm"
                  variant="secondary"
                />
              </TableCell>
            </TableRow>
          ))}
        </tbody>
      </Table>
    );
  };

  return (
    <VStack height="100dvh" isScrollable xstyle={styles.page}>
      <VStack gap={6} padding={6} width="100%" xstyle={styles.pageContent}>
        <VStack gap={2}>
          <HStack align="center" gap={3} justify="between" wrap="wrap">
            <Heading level={1}>Workflow Dashboard</Heading>
            <Button
              label="New workflow"
              onClick={() => {
                setCreateDialogSession((session) => session + 1);
                setIsCreateDialogOpen(true);
              }}
              variant="primary"
            />
          </HStack>
          <Text color="secondary">
            Manage workflows in bulk and review runs across every workflow.
            Paused workflows block new starts. Test mode makes runs execute with
            test-mode action behavior.
          </Text>
        </VStack>

        <div {...stylex.props(styles.dashboardGrid)}>
          <Card padding={0}>
            <HStack
              align="center"
              gap={2}
              justify="between"
              padding={4}
              wrap="wrap"
            >
              <VStack gap={0.5}>
                <Heading level={2}>Workflows</Heading>
                <Text color="secondary" type="supporting">
                  Select one or more workflows to run bulk actions.
                </Text>
              </VStack>
              <Button
                isDisabled={isLoadingWorkflows || lifecycleAction !== null}
                label="Refresh workflows"
                onClick={refreshWorkflows}
                size="sm"
                variant="secondary"
              />
            </HStack>

            <Divider />
            <HStack gap={2} padding={4} wrap="wrap">
              <Button
                isDisabled={
                  selectedActionableIds.length === 0 || lifecycleAction !== null
                }
                label="Pause selected"
                onClick={() => {
                  runLifecycleAction("pause", selectedActionableIds);
                }}
                size="sm"
                variant="secondary"
              />
              <Button
                isDisabled={
                  selectedActionableIds.length === 0 || lifecycleAction !== null
                }
                label="Resume selected"
                onClick={() => {
                  runLifecycleAction("resume", selectedActionableIds);
                }}
                size="sm"
                variant="secondary"
              />
              <Button
                isDisabled={
                  selectedActionableIds.length === 0 || lifecycleAction !== null
                }
                label="Delete selected"
                onClick={() => {
                  openDeleteConfirmation(selectedActionableIds);
                }}
                size="sm"
                variant="destructive"
              />
            </HStack>

            <Divider />
            <div {...stylex.props(styles.tableViewport)}>
              {renderWorkflowContent()}
            </div>
          </Card>

          <Card padding={0}>
            <HStack
              align="center"
              gap={2}
              justify="between"
              padding={4}
              wrap="wrap"
            >
              <VStack gap={0.5}>
                <Heading level={2}>All Runs</Heading>
                <Text color="secondary" type="supporting">
                  Combined run history across workflows.
                </Text>
              </VStack>
              <Button
                isDisabled={isLoadingRuns || isLoadingMoreRuns}
                label="Refresh runs"
                onClick={() => {
                  void refreshRuns();
                }}
                size="sm"
                variant="secondary"
              />
            </HStack>

            <Divider />
            <HStack gap={2} padding={4} wrap="wrap">
              <ToggleButton
                isPressed={statusFilters.size === 0}
                label="All statuses"
                onPressedChange={() => setStatusFilters(new Set())}
                size="sm"
              />
              {STATUS_OPTIONS.map((status) => (
                <ToggleButton
                  isPressed={statusFilters.has(status)}
                  key={status}
                  label={status}
                  onPressedChange={() => toggleStatusFilter(status)}
                  size="sm"
                />
              ))}
              <ToggleButton
                isDisabled={selectedActionableIds.length === 0}
                isPressed={showSelectedRunsOnly}
                label="Selected workflows only"
                onPressedChange={setShowSelectedRunsOnly}
                size="sm"
              />
            </HStack>

            <Divider />
            <div {...stylex.props(styles.tableViewport)}>
              {renderRunsContent()}
            </div>

            {runsQuery.hasNextPage ? (
              <>
                <Divider />
                <HStack padding={4}>
                  <Button
                    isDisabled={isLoadingMoreRuns}
                    isLoading={isLoadingMoreRuns}
                    label={isLoadingMoreRuns ? "Loading" : "Load more"}
                    onClick={() => {
                      void runsQuery.fetchNextPage();
                    }}
                    size="sm"
                    variant="secondary"
                  />
                </HStack>
              </>
            ) : null}
          </Card>
        </div>
      </VStack>

      <Dialog
        isOpen={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmDelete(null);
            setDeleteChallenge("");
          }
        }}
        purpose="form"
      >
        <Layout
          content={
            <LayoutContent>
              <VStack gap={4}>
                {confirmDelete && confirmDelete.workflowNames.length > 1 ? (
                  <ul {...stylex.props(styles.deleteList)}>
                    {confirmDelete.workflowIds.slice(0, 3).map((id, index) => (
                      <li key={id}>
                        <Text color="secondary">
                          {confirmDelete.workflowNames[index]}
                        </Text>
                      </li>
                    ))}
                    {confirmDelete.workflowNames.length > 3 ? (
                      <li>
                        <Text color="secondary">
                          and {confirmDelete.workflowNames.length - 3} more
                        </Text>
                      </li>
                    ) : null}
                  </ul>
                ) : null}
                {confirmDelete &&
                confirmDelete.workflowIds.length >
                  DELETE_CHALLENGE_THRESHOLD ? (
                  <TextInput
                    label={`Type ${confirmDelete.workflowIds.length} to confirm`}
                    onChange={setDeleteChallenge}
                    value={deleteChallenge}
                    width="100%"
                  />
                ) : null}
              </VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <HStack gap={2} justify="end">
                <Button
                  label="Cancel"
                  onClick={() => {
                    setConfirmDelete(null);
                    setDeleteChallenge("");
                  }}
                  variant="secondary"
                />
                <Button
                  isDisabled={
                    confirmDelete !== null &&
                    confirmDelete.workflowIds.length >
                      DELETE_CHALLENGE_THRESHOLD &&
                    deleteChallenge.trim() !==
                      String(confirmDelete.workflowIds.length)
                  }
                  label="Delete"
                  onClick={() => {
                    if (!confirmDelete) {
                      return;
                    }

                    runLifecycleAction("delete", confirmDelete.workflowIds);
                    setConfirmDelete(null);
                    setDeleteChallenge("");
                  }}
                  variant="destructive"
                />
              </HStack>
            </LayoutFooter>
          }
          header={
            <DialogHeader
              onOpenChange={(open) => {
                if (!open) {
                  setConfirmDelete(null);
                  setDeleteChallenge("");
                }
              }}
              subtitle={confirmDelete?.description}
              title={confirmDelete?.title ?? "Delete workflows"}
            />
          }
        />
      </Dialog>
      <CreateWorkflowDialog
        key={createDialogSession}
        existingWorkflowNames={workflows.map((workflow) => workflow.name)}
        onCreated={(workflowId) =>
          navigate({ to: "/workflows/$workflowId", params: { workflowId } })
        }
        onOpenChange={setIsCreateDialogOpen}
        open={isCreateDialogOpen}
      />
    </VStack>
  );
}

const styles = stylex.create({
  page: {
    pointerEvents: "auto",
  },
  pageContent: {
    marginInline: "auto",
    maxWidth: "1600px",
  },
  dashboardGrid: {
    display: "grid",
    gap: spacingVars["--spacing-6"],
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      "@media (min-width: 1280px)": "minmax(0, 1fr) minmax(0, 1.5fr)",
    },
  },
  tableViewport: {
    maxHeight: "65vh",
    overflow: "auto",
  },
  deleteList: {
    listStyleType: "disc",
    margin: 0,
    paddingInlineStart: spacingVars["--spacing-5"],
  },
  workflowTable: {
    minWidth: "640px",
  },
  runsTable: {
    minWidth: "620px",
  },
  selectionCell: {
    minWidth: "48px",
    width: "48px",
  },
  workflowNameCell: {
    minWidth: "220px",
  },
  stateCell: {
    minWidth: "88px",
  },
  modeCell: {
    minWidth: "72px",
  },
  updatedCell: {
    minWidth: "112px",
  },
  actionsCell: {
    minWidth: "72px",
    width: "72px",
  },
  runWorkflowCell: {
    minWidth: "220px",
  },
  runStatusCell: {
    minWidth: "112px",
  },
  runStartedCell: {
    minWidth: "120px",
  },
  runDurationCell: {
    minWidth: "88px",
  },
  runOpenCell: {
    minWidth: "72px",
  },
});
import * as stylex from "@stylexjs/stylex";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import {
  Table,
  TableCell,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
