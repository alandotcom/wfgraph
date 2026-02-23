import {
  type NodeProps,
  Position,
  useUpdateNodeInternals,
} from "@xyflow/react";
import { useAtomValue } from "jotai";
import {
  AlertTriangle,
  Ban,
  Check,
  Code,
  Database,
  EyeOff,
  GitBranch,
  Hourglass,
  XCircle,
  Zap,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import {
  integrationIdsAtom,
  integrationsLoadedAtom,
} from "@/client/lib/integrations-store";
import {
  type ExecutionLogEntry,
  executionLogsAtom,
  pendingIntegrationNodesAtom,
  selectedExecutionIdAtom,
  type WorkflowNodeData,
} from "@/client/lib/workflow-store";
import {
  Node,
  NodeDescription,
  NodeTitle,
} from "@/components/flow-elements/node";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { findActionById, getIntegration } from "@/plugins";
import { cn } from "@/shared/utils";
import {
  parseTimestampWithTimezone,
  resolveWaitUntil,
} from "@/shared/utils/wait-time";
import { isConditionActionType } from "@/shared/workflow/condition-branch";

type WaitPreviewData = {
  countdown: string;
  triggerTime: string;
};

type RuntimeWaitInput = {
  waitMode?: unknown;
  waitDuration?: unknown;
  waitUntil?: unknown;
  waitOffset?: unknown;
  waitTimezone?: unknown;
  waitTimeout?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string,
  fallback = ""
): string {
  const value = config?.[key];
  return typeof value === "string" ? value : fallback;
}

function readOptionalConfigString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
}

function isRuntimeWaitInput(value: unknown): value is RuntimeWaitInput {
  return isRecord(value);
}

function hasTemplateExpression(value: unknown): boolean {
  return (
    typeof value === "string" && value.includes("{{") && value.includes("}}")
  );
}

function formatCountdown(remainingMs: number): string {
  const remainingSeconds = Math.max(Math.floor(remainingMs / 1000), 0);
  const days = Math.floor(remainingSeconds / 86_400);
  const hours = Math.floor((remainingSeconds % 86_400) / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;

  const dayLabel = days === 1 ? "day" : "days";
  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");

  return `${days} ${dayLabel} ${hh}:${mm}:${ss}`;
}

function formatTriggerTime(date: Date, timeZone?: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );

  const dayPeriod = parts.dayPeriod ? ` ${parts.dayPeriod.toUpperCase()}` : "";
  const timezoneSuffix = parts.timeZoneName ? ` ${parts.timeZoneName}` : "";

  return `${parts.month} ${parts.day}, ${parts.year} ${parts.hour}:${parts.minute}${dayPeriod}${timezoneSuffix}`;
}

function useWaitPreview(
  actionType: string,
  config: Record<string, unknown> | undefined
): WaitPreviewData | null {
  const waitMode = readConfigString(config, "waitMode", "delay");
  const shouldShowWaitPreview =
    actionType === "Wait" && (waitMode === "delay" || waitMode === "event");
  const waitDuration = config?.waitDuration;
  const waitUntil = config?.waitUntil;
  const waitOffset = config?.waitOffset;
  const waitTimezone =
    typeof config?.waitTimezone === "string" && config.waitTimezone.trim()
      ? config.waitTimezone.trim()
      : undefined;

  const hasDynamicValue =
    hasTemplateExpression(waitDuration) ||
    hasTemplateExpression(waitUntil) ||
    hasTemplateExpression(waitOffset);

  const resolution = useMemo(() => {
    if (!shouldShowWaitPreview || hasDynamicValue || waitMode === "event") {
      return null;
    }

    return resolveWaitUntil({
      waitDuration,
      waitUntil,
      waitOffset,
      waitTimezone,
    });
  }, [
    shouldShowWaitPreview,
    hasDynamicValue,
    waitMode,
    waitDuration,
    waitUntil,
    waitOffset,
    waitTimezone,
  ]);

  if (!shouldShowWaitPreview) {
    return null;
  }

  if (waitMode === "event") {
    return {
      countdown: "Waiting for event",
      triggerTime: "Resumes when a correlated event arrives",
    };
  }

  if (hasDynamicValue) {
    return {
      countdown: "Runtime-calculated",
      triggerTime: "Trigger time comes from workflow data",
    };
  }

  if (!resolution?.waitUntil) {
    return {
      countdown: "Set wait duration",
      triggerTime: "Add a valid wait time",
    };
  }

  return {
    countdown: "Delay configured",
    triggerTime: formatTriggerTime(resolution.waitUntil, waitTimezone),
  };
}

function useRuntimeWaitPreview(
  actionType: string,
  selectedExecutionId: string | null,
  nodeLog: ExecutionLogEntry | undefined
): WaitPreviewData | null {
  const shouldShowRuntimeWaitPreview =
    actionType === "Wait" &&
    selectedExecutionId !== null &&
    nodeLog !== undefined &&
    (nodeLog.status === "running" || nodeLog.status === "pending");

  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!shouldShowRuntimeWaitPreview) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [shouldShowRuntimeWaitPreview]);

  const runtimeInput = useMemo(() => {
    if (!(shouldShowRuntimeWaitPreview && isRuntimeWaitInput(nodeLog?.input))) {
      return null;
    }

    return nodeLog.input;
  }, [shouldShowRuntimeWaitPreview, nodeLog?.input]);

  const startedAt =
    shouldShowRuntimeWaitPreview && nodeLog?.startedAt !== undefined
      ? parseTimestampWithTimezone(nodeLog.startedAt)
      : null;

  if (!(shouldShowRuntimeWaitPreview && runtimeInput && startedAt)) {
    return null;
  }

  const waitMode =
    typeof runtimeInput.waitMode === "string" && runtimeInput.waitMode.trim()
      ? runtimeInput.waitMode.trim()
      : "delay";
  const waitTimezone =
    typeof runtimeInput.waitTimezone === "string" &&
    runtimeInput.waitTimezone.trim()
      ? runtimeInput.waitTimezone.trim()
      : undefined;

  if (waitMode === "hook" || waitMode === "event") {
    const timeoutResolution = resolveWaitUntil({
      now: startedAt,
      waitDuration: runtimeInput.waitTimeout,
    });

    if (!timeoutResolution.waitUntil) {
      return {
        countdown: "Waiting for event",
        triggerTime: "Resumes when matching event arrives",
      };
    }

    return {
      countdown: formatCountdown(timeoutResolution.waitUntil.getTime() - nowMs),
      triggerTime: formatTriggerTime(timeoutResolution.waitUntil, waitTimezone),
    };
  }

  const resolution = resolveWaitUntil({
    now: startedAt,
    waitDuration: runtimeInput.waitDuration,
    waitUntil: runtimeInput.waitUntil,
    waitOffset: runtimeInput.waitOffset,
    waitTimezone,
  });

  if (!resolution.waitUntil) {
    return {
      countdown: "Runtime-calculated",
      triggerTime: "Waiting timestamp unavailable",
    };
  }

  return {
    countdown: formatCountdown(resolution.waitUntil.getTime() - nowMs),
    triggerTime: formatTriggerTime(resolution.waitUntil, waitTimezone),
  };
}

// Helper to get display name for AI model
const getModelDisplayName = (modelId: string): string => {
  const modelNames: Record<string, string> = {
    "gpt-5": "GPT-5",
    "openai/gpt-5.1-instant": "GPT-5.1 Instant",
    "openai/gpt-5.1-codex": "GPT-5.1 Codex",
    "openai/gpt-5.1-codex-mini": "GPT-5.1 Codex Mini",
    "openai/gpt-5.1-thinking": "GPT-5.1 Thinking",
    "gpt-4": "GPT-4",
    "gpt-4o": "GPT-4o",
    "gpt-4o-mini": "GPT-4o Mini",
    "claude-3-5-sonnet": "Claude 3.5",
    "claude-3-opus": "Claude 3 Opus",
    "anthropic/claude-opus-4.5": "Claude Opus 4.5",
    "anthropic/claude-sonnet-4.5": "Claude Sonnet 4.5",
    "anthropic/claude-haiku-4.5": "Claude Haiku 4.5",
    "google/gemini-3-pro-preview": "Gemini 3 Pro Preview",
    "google/gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
    "google/gemini-2.5-flash": "Gemini 2.5 Flash",
    "google/gemini-2.5-pro": "Gemini 2.5 Pro",
    "meta/llama-4-scout": "Llama 4 Scout",
    "meta/llama-3.3-70b": "Llama 3.3 70B",
    "meta/llama-3.1-8b": "Llama 3.1 8B",
    "moonshotai/kimi-k2-0905": "Kimi K2",
    "openai/gpt-oss-120b": "GPT OSS 120B",
    "openai/gpt-oss-safeguard-20b": "GPT OSS Safeguard 20B",
    "openai/gpt-oss-20b": "GPT OSS 20B",
    "o1-preview": "o1 Preview",
    "o1-mini": "o1 Mini",
    "bfl/flux-2-pro": "FLUX.2 Pro",
    "bfl/flux-1-pro": "FLUX.1 Pro",
    "openai/dall-e-3": "DALL-E 3",
    "google/imagen-4.0-generate": "Imagen 4.0",
  };
  return modelNames[modelId] || modelId;
};

// System action labels (non-plugin actions)
const SYSTEM_ACTION_LABELS: Record<string, string> = {
  "HTTP Request": "System",
  "Database Query": "Database",
  Condition: "Condition",
  "Execute Code": "System",
  Wait: "System",
};

// Helper to get integration name from action type
const getIntegrationFromActionType = (actionType: string): string => {
  // Check if it's a system action first
  if (SYSTEM_ACTION_LABELS[actionType]) {
    return SYSTEM_ACTION_LABELS[actionType];
  }

  // Look up in plugin registry
  const action = findActionById(actionType);
  const integrationType = action?.integration;
  if (typeof integrationType === "string") {
    const plugin = getIntegration(integrationType);
    return plugin?.label || "System";
  }

  return "System";
};

// Helper to detect if output is a base64 image from generateImage step
function isBase64ImageOutput(output: unknown): output is { base64: string } {
  if (!isRecord(output)) {
    return false;
  }
  const { base64 } = output;
  return typeof base64 === "string" && base64.length > 100;
}

// Helper to check if an action requires an integration
const requiresIntegration = (actionType: string): boolean => {
  // System actions that require integration configuration
  const systemActionsRequiringIntegration = ["Database Query"];
  if (systemActionsRequiringIntegration.includes(actionType)) {
    return true;
  }

  // Plugin actions always require integration
  const action = findActionById(actionType);
  return Boolean(action?.integration);
};

// Helper to get provider logo for action type
const getProviderLogo = (actionType: string) => {
  // Check for system actions first (non-plugin)
  switch (actionType) {
    case "HTTP Request":
      return <Zap className="size-12 text-amber-300" strokeWidth={1.5} />;
    case "Database Query":
      return <Database className="size-12 text-blue-300" strokeWidth={1.5} />;
    case "Execute Code":
      return <Code className="size-12 text-green-300" strokeWidth={1.5} />;
    case "Condition":
      return <GitBranch className="size-12 text-pink-300" strokeWidth={1.5} />;
    case "Wait":
      return (
        <Hourglass className="size-12 text-orange-300" strokeWidth={1.5} />
      );
    default:
      // Not a system action, continue to check plugin registry
      break;
  }

  // Look up action in plugin registry and get the integration icon
  const action = findActionById(actionType);
  const integrationType = action?.integration;
  if (typeof integrationType === "string") {
    const plugin = getIntegration(integrationType);
    if (plugin?.icon) {
      const PluginIcon = plugin.icon;
      return <PluginIcon className="size-12" />;
    }
  }

  // Fallback for unknown actions
  return <Zap className="size-12 text-amber-300" strokeWidth={1.5} />;
};

// Status badge component
const StatusBadge = ({
  status,
}: {
  status?: "idle" | "running" | "success" | "error" | "cancelled";
}) => {
  // Don't show badge for idle or running (running has BorderBeam animation)
  if (!status || status === "idle" || status === "running") {
    return null;
  }

  return (
    <div
      className={cn(
        "absolute top-2 right-2 rounded-full p-1",
        status === "success" && "bg-green-500/50",
        status === "error" && "bg-red-500/50",
        status === "cancelled" && "bg-slate-500/60"
      )}
    >
      {status === "success" && (
        <Check className="size-3.5 text-white" strokeWidth={2.5} />
      )}
      {status === "error" && (
        <XCircle className="size-3.5 text-white" strokeWidth={2.5} />
      )}
      {status === "cancelled" && (
        <Ban className="size-3.5 text-white" strokeWidth={2.5} />
      )}
    </div>
  );
};

// Model badge component for AI nodes
const ModelBadge = ({ model }: { model: string }) => {
  if (!model) {
    return null;
  }

  return (
    <div className="rounded-full border border-muted-foreground/50 px-2 py-0.5 font-medium text-[10px] text-muted-foreground">
      {getModelDisplayName(model)}
    </div>
  );
};

// Generated image thumbnail with zoom dialog
function GeneratedImageThumbnail({ base64 }: { base64: string }) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <button
        className="relative size-12 cursor-zoom-in overflow-hidden rounded-lg transition-transform hover:scale-105"
        onClick={(e) => {
          e.stopPropagation();
          setDialogOpen(true);
        }}
        type="button"
      >
        <img
          alt="Generated output"
          className="size-12 object-cover"
          height={48}
          src={`data:image/png;base64,${base64}`}
          width={48}
        />
      </button>

      <Dialog onOpenChange={setDialogOpen} open={dialogOpen}>
        <DialogContent className="max-w-3xl p-2" showCloseButton={false}>
          <DialogTitle className="sr-only">Generated Image</DialogTitle>
          <div className="relative aspect-square w-full overflow-hidden rounded-lg">
            <img
              alt="Generated output"
              className="h-auto w-full object-contain"
              height={768}
              src={`data:image/png;base64,${base64}`}
              width={768}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

type ActionNodeProps = NodeProps & {
  data?: WorkflowNodeData;
  id: string;
};

const CONDITION_TRUE_HANDLE_LEFT = "38%";
const CONDITION_FALSE_HANDLE_LEFT = "62%";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Complex UI logic with multiple conditions including disabled state
export const ActionNode = memo(({ data, selected, id }: ActionNodeProps) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const selectedExecutionId = useAtomValue(selectedExecutionIdAtom);
  const executionLogs = useAtomValue(executionLogsAtom);
  const pendingIntegrationNodes = useAtomValue(pendingIntegrationNodesAtom);
  const availableIntegrationIds = useAtomValue(integrationIdsAtom);
  const integrationsLoaded = useAtomValue(integrationsLoadedAtom);
  const nodeLog = executionLogs[id];
  const actionType = readConfigString(data?.config, "actionType");
  const isConditionAction = isConditionActionType(actionType);
  const runtimeWaitPreview = useRuntimeWaitPreview(
    actionType,
    selectedExecutionId,
    nodeLog
  );
  const configWaitPreview = useWaitPreview(actionType, data?.config);
  const waitPreview = runtimeWaitPreview ?? configWaitPreview;

  useEffect(() => {
    if (!isConditionAction) {
      return;
    }

    updateNodeInternals(id);
  }, [id, isConditionAction, updateNodeInternals]);

  if (!data) {
    return null;
  }

  const status = data.status;

  // Check if this node has a generated image from the selected execution
  const hasGeneratedImage =
    selectedExecutionId &&
    actionType === "Generate Image" &&
    nodeLog?.output &&
    isBase64ImageOutput(nodeLog.output);
  const generatedImageBase64 =
    hasGeneratedImage && nodeLog?.output && isBase64ImageOutput(nodeLog.output)
      ? nodeLog.output.base64
      : null;

  // Handle empty action type (new node without selected action)
  if (!actionType) {
    const isDisabled = data.enabled === false;
    return (
      <Node
        className={cn(
          "flex h-48 w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
          selected && "border-primary",
          isDisabled && "opacity-50"
        )}
        data-testid={`action-node-${id}`}
        handles={{ target: true, source: true }}
        status={status}
      >
        {isDisabled && (
          <div className="absolute top-2 left-2 rounded-full bg-gray-500/50 p-1">
            <EyeOff className="size-3.5 text-white" />
          </div>
        )}
        <div className="flex flex-col items-center justify-center gap-3 p-6">
          <Zap className="size-12 text-muted-foreground" strokeWidth={1.5} />
          <div className="flex flex-col items-center gap-1 text-center">
            <NodeTitle className="text-base">
              {data.label || "Action"}
            </NodeTitle>
            <NodeDescription className="text-xs">
              Select an action
            </NodeDescription>
          </div>
        </div>
      </Node>
    );
  }

  // Get human-readable label from registry if no custom label is set
  const actionInfo = findActionById(actionType);
  const displayTitle = data.label || actionInfo?.label || actionType;
  const displayDescription =
    data.description || getIntegrationFromActionType(actionType);

  const needsIntegration = requiresIntegration(actionType);
  // Don't show missing indicator if we're still checking for auto-select
  const isPendingIntegrationCheck = pendingIntegrationNodes.has(id);
  // Check both that integrationId is set AND that it exists in available integrations
  const configuredIntegrationId = readOptionalConfigString(
    data.config,
    "integrationId"
  );
  const hasValidIntegration =
    configuredIntegrationId &&
    availableIntegrationIds.has(configuredIntegrationId);
  // Only show missing indicator after integrations have been loaded
  const integrationMissing =
    integrationsLoaded &&
    needsIntegration &&
    !hasValidIntegration &&
    !isPendingIntegrationCheck;

  // Get model for AI nodes
  const getAiModel = (): string | null => {
    if (actionType === "Generate Text") {
      return readConfigString(data.config, "aiModel", "meta/llama-4-scout");
    }
    if (actionType === "Generate Image") {
      return readConfigString(
        data.config,
        "imageModel",
        "google/imagen-4.0-generate"
      );
    }
    return null;
  };

  const aiModel = getAiModel();
  const isDisabled = data.enabled === false;

  return (
    <Node
      className={cn(
        "relative flex h-48 w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
        selected && "border-primary",
        isDisabled && "opacity-50"
      )}
      data-testid={`action-node-${id}`}
      handles={{
        target: true,
        source: isConditionAction
          ? [
              {
                id: "true",
                position: Position.Bottom,
                style: {
                  left: CONDITION_TRUE_HANDLE_LEFT,
                  width: 12,
                  height: 12,
                },
              },
              {
                id: "false",
                position: Position.Bottom,
                style: {
                  left: CONDITION_FALSE_HANDLE_LEFT,
                  width: 12,
                  height: 12,
                },
              },
            ]
          : true,
      }}
      status={status}
    >
      {/* Disabled badge in top left */}
      {isDisabled && (
        <div className="absolute top-2 left-2 rounded-full bg-gray-500/50 p-1">
          <EyeOff className="size-3.5 text-white" />
        </div>
      )}

      {/* Integration warning badge in top left (only if not disabled) */}
      {!isDisabled && integrationMissing && (
        <div className="absolute top-2 left-2 rounded-full bg-orange-500/50 p-1">
          <AlertTriangle className="size-3.5 text-white" />
        </div>
      )}

      {/* Status indicator badge in top right */}
      <StatusBadge status={status} />
      {isConditionAction && (
        <>
          <div className="pointer-events-none absolute -bottom-8 left-[38%] -translate-x-1/2 rounded-sm border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground leading-none">
            True
          </div>
          <div className="pointer-events-none absolute -bottom-8 left-[62%] -translate-x-1/2 rounded-sm border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground leading-none">
            False
          </div>
        </>
      )}

      <div className="flex flex-col items-center justify-center gap-3 p-6">
        {hasGeneratedImage
          ? generatedImageBase64 && (
              <GeneratedImageThumbnail base64={generatedImageBase64} />
            )
          : getProviderLogo(actionType)}
        <div className="flex flex-col items-center gap-1 text-center">
          <NodeTitle className="text-base">{displayTitle}</NodeTitle>
          {waitPreview ? (
            <div className="flex flex-col items-center gap-0.5">
              <NodeDescription className="font-medium text-[11px] tabular-nums">
                {waitPreview.countdown}
              </NodeDescription>
              <NodeDescription className="max-w-[10.5rem] text-[10px] leading-tight">
                {waitPreview.triggerTime}
              </NodeDescription>
            </div>
          ) : (
            displayDescription && (
              <NodeDescription className="text-xs">
                {displayDescription}
              </NodeDescription>
            )
          )}
          {/* Model badge for AI nodes */}
          {aiModel && <ModelBadge model={aiModel} />}
        </div>
      </div>
    </Node>
  );
});

ActionNode.displayName = "ActionNode";
