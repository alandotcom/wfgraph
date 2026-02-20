import { useAtom } from "jotai";
import { Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/client/lib/rpc-client";
import {
  currentWorkflowIdAtom,
  executionLogsAtom,
  selectedExecutionIdAtom,
} from "@/client/lib/workflow-store";
import { Spinner } from "@/components/ui/spinner";
import { WorkflowRunDetail } from "./workflow-run-detail";
import {
  applyExecutionStatusToLogs,
  createExecutionLogsMap,
  type ExecutionEvent,
  type ExecutionLog,
  type WorkflowExecution,
} from "./workflow-run-shared";
import { WorkflowRunsList } from "./workflow-runs-list";

type WorkflowRunsProps = {
  isActive?: boolean;
  onRefreshRef?: { current: (() => Promise<void>) | null };
  onStartRun?: (executionId: string) => void;
};

export function WorkflowRuns({
  isActive = false,
  onRefreshRef,
  onStartRun,
}: WorkflowRunsProps) {
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
  const [selectedExecutionId, setSelectedExecutionId] = useAtom(
    selectedExecutionIdAtom
  );
  const [, setExecutionLogs] = useAtom(executionLogsAtom);
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [logs, setLogs] = useState<Record<string, ExecutionLog[]>>({});
  const [events, setEvents] = useState<Record<string, ExecutionEvent[]>>({});
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [cancelingExecutions, setCancelingExecutions] = useState<Set<string>>(
    new Set()
  );
  const [loading, setLoading] = useState(true);

  const autoExpandedExecutionRef = useRef<string | null>(null);

  // Map node labels from API response
  const mapNodeLabels = useCallback(
    (
      logEntries: Array<{
        id: string;
        executionId: string;
        nodeId: string;
        nodeName: string;
        nodeType: string;
        status: "pending" | "running" | "success" | "error";
        input: unknown;
        output: unknown;
        error: string | null;
        startedAt: string;
        completedAt: string | null;
        duration: string | null;
      }>
    ): ExecutionLog[] =>
      logEntries.map((log) => ({
        id: log.id,
        nodeId: log.nodeId,
        nodeName: log.nodeName,
        nodeType: log.nodeType,
        status: log.status,
        startedAt: new Date(log.startedAt),
        completedAt: log.completedAt ? new Date(log.completedAt) : null,
        duration: log.duration,
        input: log.input,
        output: log.output,
        error: log.error,
      })),
    []
  );

  const loadExecutions = useCallback(
    async (showLoading = true) => {
      if (!currentWorkflowId) {
        setLoading(false);
        return;
      }

      try {
        if (showLoading) {
          setLoading(true);
        }
        const data = await api.workflow.getExecutions(currentWorkflowId);
        const mappedExecutions: WorkflowExecution[] = data.map((execution) => ({
          ...execution,
          startedAt: new Date(execution.startedAt),
          waitingAt: execution.waitingAt ? new Date(execution.waitingAt) : null,
          cancelledAt: execution.cancelledAt
            ? new Date(execution.cancelledAt)
            : null,
          completedAt: execution.completedAt
            ? new Date(execution.completedAt)
            : null,
        }));
        setExecutions(mappedExecutions);
      } catch (error) {
        console.error("Failed to load executions:", error);
        setExecutions([]);
      } finally {
        if (showLoading) {
          setLoading(false);
        }
      }
    },
    [currentWorkflowId]
  );

  const loadExecutionLogs = useCallback(
    async (executionId: string) => {
      try {
        const data = await api.workflow.getExecutionLogs(executionId);
        const mappedLogs = applyExecutionStatusToLogs(
          mapNodeLabels(data.logs),
          data.execution.status
        );
        setLogs((prev) => ({ ...prev, [executionId]: mappedLogs }));
      } catch (error) {
        console.error("Failed to load execution logs:", error);
        setLogs((prev) => ({ ...prev, [executionId]: [] }));
      }
    },
    [mapNodeLabels]
  );

  const loadExecutionEvents = useCallback(async (executionId: string) => {
    try {
      const data = await api.workflow.getExecutionEvents(executionId);
      setEvents((prev) => ({
        ...prev,
        [executionId]: data.events.map((event) => ({
          ...event,
          createdAt: new Date(event.createdAt),
        })),
      }));
    } catch (error) {
      console.error("Failed to load execution events:", error);
      setEvents((prev) => ({ ...prev, [executionId]: [] }));
    }
  }, []);

  const refreshExecutionLogs = useCallback(
    async (executionId: string) => {
      try {
        const logsData = await api.workflow.getExecutionLogs(executionId);
        const mappedLogs = applyExecutionStatusToLogs(
          mapNodeLabels(logsData.logs),
          logsData.execution.status
        );
        setLogs((prev) => ({ ...prev, [executionId]: mappedLogs }));
      } catch (error) {
        console.error(`Failed to refresh logs for ${executionId}:`, error);
      }
    },
    [mapNodeLabels]
  );

  const refreshExecutionEvents = useCallback(async (executionId: string) => {
    try {
      const eventsData = await api.workflow.getExecutionEvents(executionId);
      setEvents((prev) => ({
        ...prev,
        [executionId]: eventsData.events.map((event) => ({
          ...event,
          createdAt: new Date(event.createdAt),
        })),
      }));
    } catch (error) {
      console.error(`Failed to refresh events for ${executionId}:`, error);
    }
  }, []);

  // Expose refresh function via ref
  useEffect(() => {
    if (onRefreshRef) {
      onRefreshRef.current = () => loadExecutions(false);
    }
  }, [loadExecutions, onRefreshRef]);

  // Initial load
  useEffect(() => {
    loadExecutions();
  }, [loadExecutions]);

  // Sync global execution logs atom when selected execution changes
  useEffect(() => {
    if (!selectedExecutionId) {
      setExecutionLogs({});
      return;
    }

    const selectedLogs = logs[selectedExecutionId];
    if (!selectedLogs) {
      return;
    }

    setExecutionLogs(createExecutionLogsMap(selectedLogs));
  }, [selectedExecutionId, logs, setExecutionLogs]);

  // Auto-navigate to detail for new running executions
  useEffect(() => {
    if (executions.length === 0) {
      return;
    }

    const latestExecution = executions[0];

    if (
      latestExecution.status === "running" &&
      latestExecution.id !== autoExpandedExecutionRef.current
    ) {
      autoExpandedExecutionRef.current = latestExecution.id;
      setSelectedExecutionId(latestExecution.id);
      setActiveRunId(latestExecution.id);
      loadExecutionLogs(latestExecution.id);
      loadExecutionEvents(latestExecution.id);

      if (onStartRun) {
        onStartRun(latestExecution.id);
      }
    }
  }, [
    executions,
    setSelectedExecutionId,
    loadExecutionLogs,
    loadExecutionEvents,
    onStartRun,
  ]);

  // Poll for executions and refresh active run logs
  useEffect(() => {
    if (!(isActive && currentWorkflowId)) {
      return;
    }

    const pollExecutions = async () => {
      try {
        const data = await api.workflow.getExecutions(currentWorkflowId);
        const mappedExecutions: WorkflowExecution[] = data.map((execution) => ({
          ...execution,
          startedAt: new Date(execution.startedAt),
          waitingAt: execution.waitingAt ? new Date(execution.waitingAt) : null,
          cancelledAt: execution.cancelledAt
            ? new Date(execution.cancelledAt)
            : null,
          completedAt: execution.completedAt
            ? new Date(execution.completedAt)
            : null,
        }));
        setExecutions(mappedExecutions);

        // Refresh logs/events for the active detail run
        if (activeRunId) {
          await Promise.all([
            refreshExecutionLogs(activeRunId),
            refreshExecutionEvents(activeRunId),
          ]);
        }
      } catch (error) {
        console.error("Failed to poll executions:", error);
      }
    };

    const interval = setInterval(pollExecutions, 2000);
    return () => clearInterval(interval);
  }, [
    isActive,
    currentWorkflowId,
    activeRunId,
    refreshExecutionLogs,
    refreshExecutionEvents,
  ]);

  const handleSelectRun = (executionId: string) => {
    setActiveRunId(executionId);
    setSelectedExecutionId(executionId);

    if (!logs[executionId]) {
      loadExecutionLogs(executionId).catch((error) => {
        console.error("Failed to load execution logs:", error);
      });
      loadExecutionEvents(executionId).catch((error) => {
        console.error("Failed to load execution events:", error);
      });
      setExecutionLogs({});
      return;
    }

    const executionLogEntries = logs[executionId] || [];
    setExecutionLogs(createExecutionLogsMap(executionLogEntries));
  };

  const handleBack = () => {
    setActiveRunId(null);
    setSelectedExecutionId(null);
    setExecutionLogs({});
  };

  const cancelExecution = async (executionId: string) => {
    setCancelingExecutions((prev) => new Set(prev).add(executionId));
    try {
      await api.workflow.cancelExecution(executionId);
      await Promise.all([
        loadExecutions(false),
        refreshExecutionLogs(executionId),
        refreshExecutionEvents(executionId),
      ]);
    } catch (error) {
      console.error("Failed to cancel execution:", error);
    } finally {
      setCancelingExecutions((prev) => {
        const next = new Set(prev);
        next.delete(executionId);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (executions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <div className="mb-3 rounded-lg border border-dashed p-4">
          <Play className="size-6 text-muted-foreground" />
        </div>
        <div className="font-medium text-foreground text-sm">No runs yet</div>
        <div className="mt-1 text-muted-foreground text-xs">
          Execute your workflow to see runs here
        </div>
      </div>
    );
  }

  // Detail view
  const activeExecution = activeRunId
    ? executions.find((e) => e.id === activeRunId)
    : null;

  if (activeExecution) {
    const runIndex = executions.indexOf(activeExecution);
    const runNumber = executions.length - runIndex;

    return (
      <WorkflowRunDetail
        events={events[activeExecution.id] || []}
        execution={activeExecution}
        isCanceling={cancelingExecutions.has(activeExecution.id)}
        logs={logs[activeExecution.id] || []}
        onBack={handleBack}
        onCancel={cancelExecution}
        runNumber={runNumber}
      />
    );
  }

  // List view
  return (
    <WorkflowRunsList
      executions={executions}
      onSelect={handleSelectRun}
      selectedId={selectedExecutionId}
    />
  );
}
