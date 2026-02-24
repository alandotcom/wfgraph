import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
} from "lucide-react";
import { useState } from "react";
import {
  OUTPUT_DISPLAY_CONFIGS,
  type OutputDisplayConfig,
} from "@/client/lib/output-display-configs";
import type { ExecutionLogEntry as WorkflowExecutionLogEntry } from "@/client/lib/workflow-store";
import { Button } from "@/components/ui/button";
import { findActionById } from "@/plugins";

// Shared types

export type ExecutionLog = {
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

export type WorkflowExecution = {
  id: string;
  workflowId: string;
  status: "pending" | "running" | "waiting" | "success" | "error" | "cancelled";
  triggerType: "manual" | "webhook" | "event" | null;
  runMode: "live" | "test";
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

export type ExecutionEvent = {
  id: string;
  eventType: string;
  message: string;
  metadata: unknown;
  createdAt: Date;
};

// Status helpers

export function getStatusDotClass(status: string): string {
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

export function getStatusLabel(status: string): string {
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

export function getStatusBadgeClass(status: string): string {
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

export function formatDuration(duration: string): string {
  const ms = Number.parseInt(duration, 10);
  return ms < 1000 ? `${duration}ms` : `${(ms / 1000).toFixed(2)}s`;
}

// Data helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getOutputConfig(nodeType: string): OutputDisplayConfig | undefined {
  return OUTPUT_DISPLAY_CONFIGS[nodeType];
}

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

function isBase64ImageOutput(output: unknown): output is { base64: string } {
  if (!isRecord(output)) {
    return false;
  }
  return typeof output.base64 === "string" && output.base64.length > 100;
}

function getLogStartedAtMs(log: Pick<ExecutionLog, "startedAt">): number {
  return new Date(log.startedAt).getTime();
}

export function createExecutionLogsMap(
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

export function applyExecutionStatusToLogs(
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
        status: "cancelled" as const,
        error: log.error || "Run cancelled before step completion",
      };
    }
    return log;
  });
}

// URL detection helper
function isUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Shared UI components

export function JsonWithLinks({ data }: { data: unknown }) {
  const jsonString = JSON.stringify(data, null, 2);
  const parts = jsonString.split(/("https?:\/\/[^"]+"|"[^"]*")/g);

  return (
    <>
      {parts.map((part) => {
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
        return part;
      })}
    </>
  );
}

export function CopyButton({
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

export function CollapsibleSection({
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
          {externalLink ? (
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
          ) : null}
          {copyData !== undefined ? (
            <CopyButton data={copyData} isError={isError} />
          ) : null}
        </div>
      </div>
      {isOpen ? children : null}
    </div>
  );
}

export function OutputDisplay({
  output,
  input,
  actionType,
}: {
  output: unknown;
  input?: unknown;
  actionType?: string;
}) {
  const action = actionType ? findActionById(actionType) : undefined;
  const pluginConfig = action?.outputConfig;
  const builtInConfig = actionType ? getOutputConfig(actionType) : undefined;
  const effectiveBuiltInConfig =
    pluginConfig?.type !== "component" ? pluginConfig : builtInConfig;
  const displayValue = effectiveBuiltInConfig
    ? getOutputDisplayValue(output, effectiveBuiltInConfig)
    : undefined;
  const legacyBase64Output = isBase64ImageOutput(output) ? output.base64 : null;
  const isLegacyBase64 =
    !(pluginConfig || builtInConfig) && !!legacyBase64Output;

  const renderRichResult = () => {
    if (pluginConfig?.type === "component") {
      const CustomComponent = pluginConfig.component;
      return (
        <div className="overflow-hidden rounded-lg border bg-muted/50 p-3">
          <CustomComponent input={input} output={output} />
        </div>
      );
    }

    if (effectiveBuiltInConfig && displayValue) {
      switch (effectiveBuiltInConfig.type) {
        case "image": {
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
  const externalLink =
    effectiveBuiltInConfig?.type === "url" && displayValue
      ? displayValue
      : undefined;

  return (
    <>
      <CollapsibleSection copyData={output} title="Output">
        <pre className="overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
          <JsonWithLinks data={output} />
        </pre>
      </CollapsibleSection>

      {hasRichResult ? (
        <CollapsibleSection
          defaultExpanded
          externalLink={externalLink}
          title="Result"
        >
          {richResult}
        </CollapsibleSection>
      ) : null}
    </>
  );
}
