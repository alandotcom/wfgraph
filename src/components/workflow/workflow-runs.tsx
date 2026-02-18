import { useAtom } from "jotai";
import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Loader2,
  Play,
  X,
} from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  OUTPUT_DISPLAY_CONFIGS,
  type OutputDisplayConfig,
} from "@/client/lib/output-display-configs";
import { api } from "@/client/lib/rpc-client";
import {
  currentWorkflowIdAtom,
  executionLogsAtom,
  selectedExecutionIdAtom,
  type ExecutionLogEntry as WorkflowExecutionLogEntry,
} from "@/client/lib/workflow-store";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { findActionById } from "@/plugins";
import { cn } from "@/shared/utils";
import { getRelativeTime } from "@/shared/utils/time";

type ExecutionLog = {
  id: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: "pending" | "running" | "success" | "error" | "cancelled";
  startedAt: Date;
  completedAt: Date | null;
  duration: string | null;
  input?: unknown;
  output?: unknown;
  error: string | null;
};

type WorkflowExecution = {
  id: string;
  workflowId: string;
  status: "pending" | "running" | "waiting" | "success" | "error" | "cancelled";
  triggerType: "manual" | "webhook" | null;
  isDryRun: boolean;
  triggerEventType: string | null;
  correlationKey: string | null;
  workflowRunId: string | null;
  startedAt: Date;
  waitingAt: Date | null;
  cancelledAt: Date | null;
  completedAt: Date | null;
  duration: string | null;
  error: string | null;
};

type ExecutionEvent = {
  id: string;
  eventType: string;
  message: string;
  metadata: unknown;
  createdAt: Date;
};

type WorkflowRunsProps = {
  isActive?: boolean;
  onRefreshRef?: { current: (() => Promise<void>) | null };
  onStartRun?: (executionId: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Helper to get the output display config for a node type
function getOutputConfig(nodeType: string): OutputDisplayConfig | undefined {
  return OUTPUT_DISPLAY_CONFIGS[nodeType];
}

// Helper to extract the displayable value from output based on config
function getOutputDisplayValue(
  output: unknown,
  config: { type: "image" | "video" | "url"; field: string }
): string | undefined {
  if (!isRecord(output)) {
    return;
  }
  const value = output[config.field];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return;
}

// Fallback: detect if output is a base64 image (for legacy support)
function isBase64ImageOutput(output: unknown): output is { base64: string } {
  if (!isRecord(output)) {
    return false;
  }
  return typeof output.base64 === "string" && output.base64.length > 100;
}

function getLogStartedAtMs(log: Pick<ExecutionLog, "startedAt">): number {
  return new Date(log.startedAt).getTime();
}

// Helper to convert execution logs to a map by nodeId for the global atom
function createExecutionLogsMap(
  logs: ExecutionLog[]
): Record<string, WorkflowExecutionLogEntry> {
  const logsMap: Record<string, WorkflowExecutionLogEntry> = {};
  for (const log of logs) {
    const previous = logsMap[log.nodeId];
    if (
      previous?.startedAt !== undefined &&
      getLogStartedAtMs(log) < new Date(previous.startedAt).getTime()
    ) {
      continue;
    }

    logsMap[log.nodeId] = {
      nodeId: log.nodeId,
      nodeName: log.nodeName,
      nodeType: log.nodeType,
      status: log.status,
      input: log.input,
      output: log.output,
      startedAt: log.startedAt,
      completedAt: log.completedAt,
    };
  }
  return logsMap;
}

// Helper to check if a string is a URL
function isUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Component to render JSON with clickable links
function JsonWithLinks({ data }: { data: unknown }) {
  // Use regex to find and replace URLs in the JSON string
  const jsonString = JSON.stringify(data, null, 2);

  // Split by quoted strings to preserve structure
  const parts = jsonString.split(/("https?:\/\/[^"]+"|"[^"]*")/g);

  return (
    <>
      {parts.map((part) => {
        // Check if this part is a quoted URL string
        if (part.startsWith('"') && part.endsWith('"')) {
          const innerValue = part.slice(1, -1);
          if (isUrl(innerValue)) {
            return (
              <a
                className="text-blue-500 underline hover:text-blue-400"
                href={innerValue}
                key={innerValue}
                rel="noopener noreferrer"
                target="_blank"
              >
                {part}
              </a>
            );
          }
        }
        // For non-URL parts, just render as text (no key needed for text nodes)
        return part;
      })}
    </>
  );
}

// Reusable copy button component
function CopyButton({
  data,
  isError = false,
}: {
  data: unknown;
  isError?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const text = isError ? String(data) : JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  return (
    <Button
      className="h-7 px-2"
      onClick={handleCopy}
      size="sm"
      type="button"
      variant="ghost"
    >
      {copied ? (
        <Check className="h-3 w-3 text-green-600" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </Button>
  );
}

// Collapsible section component
function CollapsibleSection({
  title,
  children,
  defaultExpanded = false,
  copyData,
  isError = false,
  externalLink,
}: {
  title: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  copyData?: unknown;
  isError?: boolean;
  externalLink?: string;
}) {
  const [isOpen, setIsOpen] = useState(defaultExpanded);

  return (
    <div>
      <div className="mb-2 flex w-full items-center justify-between">
        <button
          className="flex items-center gap-1.5"
          onClick={() => setIsOpen(!isOpen)}
          type="button"
        >
          {isOpen ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
          <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {title}
          </span>
        </button>
        <div className="flex items-center gap-1">
          {externalLink && (
            <Button
              className="h-7 px-2"
              render={
                <a
                  href={externalLink}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <span className="sr-only">Open external link</span>
                </a>
              }
              size="sm"
              variant="ghost"
            >
              <ExternalLink className="h-3 w-3" />
            </Button>
          )}
          {copyData !== undefined && (
            <CopyButton data={copyData} isError={isError} />
          )}
        </div>
      </div>
      {isOpen && children}
    </div>
  );
}

// Component for rendering output with rich display support
function OutputDisplay({
  output,
  input,
  actionType,
}: {
  output: unknown;
  input?: unknown;
  actionType?: string;
}) {
  // Look up action from plugin registry to get outputConfig (including custom components)
  const action = actionType ? findActionById(actionType) : undefined;
  const pluginConfig = action?.outputConfig;

  // Fall back to auto-generated config for legacy support (only built-in types)
  const builtInConfig = actionType ? getOutputConfig(actionType) : undefined;

  // Get the effective built-in config (plugin config if not component, else auto-generated)
  const effectiveBuiltInConfig =
    pluginConfig?.type !== "component" ? pluginConfig : builtInConfig;

  // Get display value for built-in types (image/video/url)
  const displayValue = effectiveBuiltInConfig
    ? getOutputDisplayValue(output, effectiveBuiltInConfig)
    : undefined;

  // Check for legacy base64 image
  const legacyBase64Output = isBase64ImageOutput(output) ? output.base64 : null;
  const isLegacyBase64 =
    !(pluginConfig || builtInConfig) && !!legacyBase64Output;

  const renderRichResult = () => {
    // Priority 1: Custom component from plugin outputConfig
    if (pluginConfig?.type === "component") {
      const CustomComponent = pluginConfig.component;
      return (
        <div className="overflow-hidden rounded-lg border bg-muted/50 p-3">
          <CustomComponent input={input} output={output} />
        </div>
      );
    }

    // Priority 2: Built-in output config (image/video/url)
    if (effectiveBuiltInConfig && displayValue) {
      switch (effectiveBuiltInConfig.type) {
        case "image": {
          // Handle base64 images by adding data URI prefix if needed
          const imageSrc =
            effectiveBuiltInConfig.field === "base64" &&
            !displayValue.startsWith("data:")
              ? `data:image/png;base64,${displayValue}`
              : displayValue;
          return (
            <div className="overflow-hidden rounded-lg border bg-muted/50 p-3">
              <img
                alt="Generated output"
                className="max-h-96 w-auto rounded"
                height={384}
                src={imageSrc}
                width={384}
              />
            </div>
          );
        }
        case "video":
          return (
            <div className="overflow-hidden rounded-lg border bg-muted/50 p-3">
              <video
                className="max-h-96 w-auto rounded"
                controls
                src={displayValue}
              >
                <track kind="captions" />
              </video>
            </div>
          );
        case "url":
          return (
            <div className="overflow-hidden rounded-lg border bg-muted/50">
              <iframe
                className="h-96 w-full rounded"
                sandbox="allow-scripts"
                src={displayValue}
                title="Output preview"
              />
            </div>
          );
        default:
          return null;
      }
    }

    // Fallback: legacy base64 image detection
    if (isLegacyBase64) {
      return (
        <div className="overflow-hidden rounded-lg border bg-muted/50 p-3">
          <img
            alt="AI output"
            className="max-h-96 w-auto rounded"
            height={384}
            src={`data:image/png;base64,${legacyBase64Output}`}
            width={384}
          />
        </div>
      );
    }

    return null;
  };

  const richResult = renderRichResult();
  const hasRichResult = richResult !== null;

  // Determine external link for URL type configs
  const externalLink =
    effectiveBuiltInConfig?.type === "url" && displayValue
      ? displayValue
      : undefined;

  return (
    <>
      {/* Always show JSON output */}
      <CollapsibleSection copyData={output} title="Output">
        <pre className="overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
          <JsonWithLinks data={output} />
        </pre>
      </CollapsibleSection>

      {/* Show rich result if available */}
      {hasRichResult && (
        <CollapsibleSection
          defaultExpanded
          externalLink={externalLink}
          title="Result"
        >
          {richResult}
        </CollapsibleSection>
      )}
    </>
  );
}

function getStatusIcon(status: string): JSX.Element {
  switch (status) {
    case "success":
      return <Check className="h-3 w-3 text-white" />;
    case "error":
      return <X className="h-3 w-3 text-white" />;
    case "running":
      return <Loader2 className="h-3 w-3 animate-spin text-white" />;
    case "waiting":
      return <Clock className="h-3 w-3 text-white" />;
    case "cancelled":
      return <Ban className="h-3 w-3 text-white" />;
    default:
      return <Clock className="h-3 w-3 text-white" />;
  }
}

function getStatusDotClass(status: string): string {
  switch (status) {
    case "success":
      return "bg-green-600";
    case "error":
      return "bg-red-600";
    case "running":
      return "bg-blue-600";
    case "waiting":
      return "bg-amber-600";
    case "cancelled":
      return "bg-slate-600";
    default:
      return "bg-muted-foreground";
  }
}

function getStatusBadgeClass(status: string): string {
  switch (status) {
    case "success":
      return "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300";
    case "error":
      return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
    case "running":
      return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";
    case "waiting":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "cancelled":
      return "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300";
    default:
      return "border-muted bg-muted/40 text-muted-foreground";
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case "success":
      return "Success";
    case "error":
      return "Error";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "cancelled":
      return "Cancelled";
    default:
      return "Unknown";
  }
}

function applyExecutionStatusToLogs(
  logEntries: ExecutionLog[],
  executionStatus: string
): ExecutionLog[] {
  if (executionStatus !== "cancelled") {
    return logEntries;
  }

  return logEntries.map((log) => {
    if (log.status === "pending" || log.status === "running") {
      return {
        ...log,
        status: "cancelled",
        error: log.error || "Run cancelled before step completion",
      };
    }
    return log;
  });
}

// Component for rendering individual execution log entries
function ExecutionLogEntry({
  log,
  isExpanded,
  onToggle,
  statusIconFor,
  statusDotClassFor,
  isFirst,
  isLast,
}: {
  log: ExecutionLog;
  isExpanded: boolean;
  onToggle: () => void;
  statusIconFor: (status: string) => JSX.Element;
  statusDotClassFor: (status: string) => string;
  isFirst: boolean;
  isLast: boolean;
}) {
  return (
    <div className="relative flex gap-3" key={log.id}>
      {/* Timeline connector */}
      <div className="relative -ml-px flex flex-col items-center pt-2">
        {!isFirst && (
          <div className="absolute bottom-full h-2 w-px bg-border" />
        )}
        <div
          className={cn(
            "z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-0",
            statusDotClassFor(log.status)
          )}
        >
          {statusIconFor(log.status)}
        </div>
        {!isLast && (
          <div className="absolute top-[calc(0.5rem+1.25rem)] bottom-0 w-px bg-border" />
        )}
      </div>

      {/* Step content */}
      <div className="min-w-0 flex-1">
        <button
          className="group w-full rounded-lg py-2 text-left transition-colors hover:bg-muted/50"
          onClick={onToggle}
          type="button"
        >
          <div className="flex items-center gap-3">
            {/* Step content */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate font-medium text-sm transition-colors group-hover:text-foreground">
                  {log.nodeName || log.nodeType}
                </span>
              </div>
            </div>

            {log.duration && (
              <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
                {Number.parseInt(log.duration, 10) < 1000
                  ? `${log.duration}ms`
                  : `${(Number.parseInt(log.duration, 10) / 1000).toFixed(2)}s`}
              </span>
            )}
          </div>
        </button>

        {isExpanded && (
          <div className="mt-2 mb-2 space-y-3 px-3">
            {log.input !== null && log.input !== undefined && (
              <CollapsibleSection copyData={log.input} title="Input">
                <pre className="overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
                  <JsonWithLinks data={log.input} />
                </pre>
              </CollapsibleSection>
            )}
            {log.output !== null && log.output !== undefined && (
              <OutputDisplay
                actionType={log.nodeType}
                input={log.input}
                output={log.output}
              />
            )}
            {log.error && (
              <CollapsibleSection
                copyData={log.error}
                defaultExpanded
                isError
                title="Error"
              >
                <pre className="overflow-auto rounded-lg border border-red-500/20 bg-red-500/5 p-3 font-mono text-red-600 text-xs leading-relaxed">
                  {log.error}
                </pre>
              </CollapsibleSection>
            )}
            {!(log.input || log.output || log.error) && (
              <div className="rounded-lg border bg-muted/30 py-4 text-center text-muted-foreground text-xs">
                No data recorded
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

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
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  const [cancelingExecutions, setCancelingExecutions] = useState<Set<string>>(
    new Set()
  );
  const [loading, setLoading] = useState(true);

  // Track which execution we've already auto-expanded to prevent loops
  const autoExpandedExecutionRef = useRef<string | null>(null);

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

  // Expose refresh function via ref
  useEffect(() => {
    if (onRefreshRef) {
      onRefreshRef.current = () => loadExecutions(false);
    }
  }, [loadExecutions, onRefreshRef]);

  useEffect(() => {
    loadExecutions();
  }, [loadExecutions]);

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

  // Helper function to map node IDs to labels
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

  const loadExecutionLogs = useCallback(
    async (executionId: string) => {
      try {
        const data = await api.workflow.getExecutionLogs(executionId);
        const mappedLogs = applyExecutionStatusToLogs(
          mapNodeLabels(data.logs),
          data.execution.status
        );
        setLogs((prev) => ({
          ...prev,
          [executionId]: mappedLogs,
        }));
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

  // Notify parent when a new execution starts and auto-expand it
  useEffect(() => {
    if (executions.length === 0) {
      return;
    }

    const latestExecution = executions[0];

    // Check if this is a new running execution that we haven't auto-expanded yet
    if (
      latestExecution.status === "running" &&
      latestExecution.id !== autoExpandedExecutionRef.current
    ) {
      // Mark this execution as auto-expanded
      autoExpandedExecutionRef.current = latestExecution.id;

      // Auto-select the new running execution
      setSelectedExecutionId(latestExecution.id);

      // Auto-expand the run
      setExpandedRuns((prev) => {
        const newExpanded = new Set(prev);
        newExpanded.add(latestExecution.id);
        return newExpanded;
      });

      // Load logs for the new execution
      loadExecutionLogs(latestExecution.id);
      loadExecutionEvents(latestExecution.id);

      // Notify parent
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

  // Helper to refresh logs for a single execution
  const refreshExecutionLogs = useCallback(
    async (executionId: string) => {
      try {
        const logsData = await api.workflow.getExecutionLogs(executionId);
        const mappedLogs = applyExecutionStatusToLogs(
          mapNodeLabels(logsData.logs),
          logsData.execution.status
        );
        setLogs((prev) => ({
          ...prev,
          [executionId]: mappedLogs,
        }));
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

  // Poll for new executions when tab is active
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

        // Also refresh logs for expanded runs
        await Promise.all(
          [...expandedRuns].map(async (executionId) => {
            await Promise.all([
              refreshExecutionLogs(executionId),
              refreshExecutionEvents(executionId),
            ]);
          })
        );
      } catch (error) {
        console.error("Failed to poll executions:", error);
      }
    };

    const interval = setInterval(pollExecutions, 2000);
    return () => clearInterval(interval);
  }, [
    isActive,
    currentWorkflowId,
    expandedRuns,
    refreshExecutionLogs,
    refreshExecutionEvents,
  ]);

  const toggleRun = async (executionId: string) => {
    const newExpanded = new Set(expandedRuns);
    if (newExpanded.has(executionId)) {
      newExpanded.delete(executionId);
    } else {
      newExpanded.add(executionId);
      // Load logs when expanding
      await Promise.all([
        loadExecutionLogs(executionId),
        loadExecutionEvents(executionId),
      ]);
    }
    setExpandedRuns(newExpanded);
  };

  const selectRun = (executionId: string) => {
    // If already selected, deselect it
    if (selectedExecutionId === executionId) {
      setSelectedExecutionId(null);
      setExecutionLogs({});
      return;
    }

    // Select the run without toggling expansion
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

    // Update global execution logs atom with logs for this execution
    const executionLogEntries = logs[executionId] || [];
    setExecutionLogs(createExecutionLogsMap(executionLogEntries));
  };

  const toggleLog = (logId: string) => {
    const newExpanded = new Set(expandedLogs);
    if (newExpanded.has(logId)) {
      newExpanded.delete(logId);
    } else {
      newExpanded.add(logId);
    }
    setExpandedLogs(newExpanded);
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
          <Play className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="font-medium text-foreground text-sm">No runs yet</div>
        <div className="mt-1 text-muted-foreground text-xs">
          Execute your workflow to see runs here
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Run card rendering intentionally combines summary, events, and step details in one mapped block. */}
      {executions.map((execution, index) => {
        const isExpanded = expandedRuns.has(execution.id);
        const isSelected = selectedExecutionId === execution.id;
        const executionLogs = (logs[execution.id] || []).toSorted((a, b) => {
          // Sort by startedAt to ensure first to last order
          return (
            new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
          );
        });
        const executionEvents = events[execution.id] || [];
        const isCanceling = cancelingExecutions.has(execution.id);

        return (
          <div
            className={cn(
              "overflow-hidden rounded-lg border bg-card transition-all",
              isSelected &&
                "ring-2 ring-primary ring-offset-2 ring-offset-background"
            )}
            key={execution.id}
          >
            <div className="flex w-full items-center gap-3 p-4">
              <button
                className="flex size-5 shrink-0 items-center justify-center rounded-full border-0 transition-colors hover:bg-muted"
                onClick={() => toggleRun(execution.id)}
                type="button"
              >
                <div
                  className={cn(
                    "flex size-5 items-center justify-center rounded-full border-0",
                    getStatusDotClass(execution.status)
                  )}
                >
                  {getStatusIcon(execution.status)}
                </div>
              </button>

              <button
                className="min-w-0 flex-1 text-left transition-colors hover:opacity-80"
                onClick={() => selectRun(execution.id)}
                type="button"
              >
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-semibold text-sm">
                    Run #{executions.length - index}
                  </span>
                  <span
                    className={cn(
                      "rounded border px-1.5 py-0.5 font-medium text-[10px] uppercase",
                      getStatusBadgeClass(execution.status)
                    )}
                  >
                    {getStatusLabel(execution.status)}
                  </span>
                  {execution.isDryRun && (
                    <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-medium text-[10px] text-amber-700 uppercase dark:text-amber-300">
                      Dry Run
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 font-mono text-muted-foreground text-xs">
                  <span>{getRelativeTime(execution.startedAt)}</span>
                  {execution.triggerEventType && (
                    <>
                      <span>•</span>
                      <span>{execution.triggerEventType}</span>
                    </>
                  )}
                  {execution.duration && (
                    <>
                      <span>•</span>
                      <span className="tabular-nums">
                        {Number.parseInt(execution.duration, 10) < 1000
                          ? `${execution.duration}ms`
                          : `${(Number.parseInt(execution.duration, 10) / 1000).toFixed(2)}s`}
                      </span>
                    </>
                  )}
                  {executionLogs.length > 0 && (
                    <>
                      <span>•</span>
                      <span>
                        {executionLogs.length}{" "}
                        {executionLogs.length === 1 ? "step" : "steps"}
                      </span>
                    </>
                  )}
                  {executionEvents.length > 0 && (
                    <>
                      <span>•</span>
                      <span>
                        {executionEvents.length}{" "}
                        {executionEvents.length === 1 ? "event" : "events"}
                      </span>
                    </>
                  )}
                </div>
              </button>

              {execution.status === "waiting" && (
                <Button
                  className="mr-1"
                  disabled={isCanceling}
                  onClick={(event) => {
                    event.stopPropagation();
                    cancelExecution(execution.id).catch((error) => {
                      console.error("Failed to cancel execution:", error);
                    });
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {isCanceling ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Ban className="h-3 w-3" />
                  )}
                  <span className="ml-1">Cancel</span>
                </Button>
              )}

              <button
                className="flex shrink-0 items-center justify-center rounded p-1 transition-colors hover:bg-muted"
                onClick={() => toggleRun(execution.id)}
                type="button"
              >
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            </div>

            {isExpanded && (
              <div className="border-t bg-muted/20">
                <div className="space-y-4 p-4">
                  {executionEvents.length > 0 && (
                    <div className="space-y-2 rounded-lg border bg-card p-3">
                      <div className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                        Audit Events
                      </div>
                      <div className="space-y-2">
                        {executionEvents.map((event) => (
                          <div
                            className="flex items-center justify-between rounded-md border bg-muted/30 px-2 py-1.5"
                            key={event.id}
                          >
                            <div className="min-w-0">
                              <div className="truncate font-medium text-xs">
                                {event.message}
                              </div>
                              <div className="truncate text-[11px] text-muted-foreground">
                                {event.eventType}
                              </div>
                            </div>
                            <div className="ml-3 shrink-0 text-[11px] text-muted-foreground">
                              {getRelativeTime(event.createdAt)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {executionLogs.length === 0 ? (
                    <div className="py-8 text-center text-muted-foreground text-xs">
                      No steps recorded
                    </div>
                  ) : (
                    <div>
                      {executionLogs.map((log, logIndex) => (
                        <ExecutionLogEntry
                          isExpanded={expandedLogs.has(log.id)}
                          isFirst={logIndex === 0}
                          isLast={logIndex === executionLogs.length - 1}
                          key={log.id}
                          log={log}
                          onToggle={() => toggleLog(log.id)}
                          statusDotClassFor={getStatusDotClass}
                          statusIconFor={getStatusIcon}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
