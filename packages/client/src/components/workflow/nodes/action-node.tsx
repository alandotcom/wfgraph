import {
  type NodeProps,
  Position,
  useUpdateNodeInternals,
} from "@xyflow/react";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import {
  AlertTriangle,
  EyeOff,
  GitBranch,
  Hourglass,
  Split,
  Zap,
} from "lucide-react";
import { Schema } from "effect";
import { memo, useMemo, useState } from "react";
import {
  Node,
  NodeDescription,
  NodeTitle,
} from "#src/components/flow-elements/node";
import { Dialog, DialogContent, DialogTitle } from "#src/components/ui/dialog";
import { readBase64ImageOutput } from "#src/components/workflow/workflow-run-shared";
import { selectedExecutionIdAtom } from "#src/lib/workflow-ui-store";
import {
  type ExecutionLogEntry,
  type WorkflowNodeData,
} from "#src/lib/workflow-graph-types";
import { getExtensionCatalog } from "#src/lib/extensions";
import { findAction, findIntegration } from "@rova/shared/extensions/catalog";
import { useIntegrationUi } from "#src/components/integration-ui-provider";
import { readAs } from "@rova/shared/types/schema";
import { cn } from "@rova/shared/utils";
import {
  parseTimestampWithTimezone,
  resolveWaitUntil,
} from "@rova/shared/utils/wait-time";
import { BUILT_IN_ACTION_IDS } from "@rova/shared/actions/built-in-actions";
import { isConditionActionType } from "@rova/shared/conditions/condition-branch";
import {
  eventSplitOutlet,
  isEventSplitActionType,
} from "@rova/shared/lifecycle/event-split";
import { useEventSplitOutlets } from "#src/lib/event-split-outlets";
import { eventSplitCardWidth } from "#src/components/workflow/workflow-node-dimensions";
import { useAfterPaint, useNowMs } from "#src/hooks/effects";
import { useExecutionLogsByNode } from "#src/hooks/use-execution-logs";
import {
  readConfigString,
  readConfigStringOr,
} from "@rova/shared/graph/node-config";
import {
  integrationIdsQueryOptions,
  NO_INTEGRATION_IDS,
} from "#src/lib/rpc-query";

type WaitPreviewData = {
  countdown: string;
  triggerTime: string;
};

/**
 * The Wait step's resolved config as it was written to the step log.
 *
 * That log row is JSONB read back from the database, so the shape is parsed here
 * before the countdown is computed from it. The individual wait values stay
 * `unknown` because `resolveWaitUntil` accepts an ISO timestamp, a duration
 * string, or a unix epoch number and decides for itself what each one is.
 */
const readRuntimeWaitInput = readAs(
  Schema.Struct({
    // A mode of whitespace means the same thing as an absent one: a plain delay.
    waitMode: Schema.optionalKey(Schema.Trim),
    waitTimezone: Schema.optionalKey(Schema.Trim),
    waitDuration: Schema.optionalKey(Schema.Unknown),
    waitUntil: Schema.optionalKey(Schema.Unknown),
    waitOffset: Schema.optionalKey(Schema.Unknown),
    waitTimeout: Schema.optionalKey(Schema.Unknown),
  })
);

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
  const waitMode = readConfigStringOr(config, "waitMode", "delay");
  const shouldShowWaitPreview =
    actionType === BUILT_IN_ACTION_IDS.wait &&
    (waitMode === "delay" || waitMode === "event");
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
      triggerTime: "Resumes when a matching event arrives",
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
    actionType === BUILT_IN_ACTION_IDS.wait &&
    selectedExecutionId !== null &&
    nodeLog !== undefined &&
    (nodeLog.status === "running" || nodeLog.status === "pending");

  // A countdown has to tick on screen even though nothing in the app's state
  // is changing.
  const nowMs = useNowMs({
    intervalMs: 1000,
    enabled: shouldShowRuntimeWaitPreview,
  });

  const runtimeInput = useMemo(() => {
    if (!shouldShowRuntimeWaitPreview) {
      return null;
    }

    return readRuntimeWaitInput(nodeLog?.input) ?? null;
  }, [shouldShowRuntimeWaitPreview, nodeLog?.input]);

  const startedAt =
    shouldShowRuntimeWaitPreview && nodeLog?.startedAt !== undefined
      ? parseTimestampWithTimezone(nodeLog.startedAt)
      : null;

  if (!(shouldShowRuntimeWaitPreview && runtimeInput && startedAt)) {
    return null;
  }

  const waitMode = runtimeInput.waitMode || "delay";
  const waitTimezone = runtimeInput.waitTimezone || undefined;

  if (waitMode === "event") {
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

// The badge over an action node: the integration it belongs to, by the label that
// integration goes by. An action belonging to none reads as "System", which is
// the engine's own: Condition and Wait, neither of which names a connection.
const getIntegrationFromActionType = (actionType: string): string => {
  const catalog = getExtensionCatalog();
  const integrationType = findAction(catalog, actionType)?.integration;

  return integrationType
    ? findIntegration(catalog, integrationType)?.label || "System"
    : "System";
};

// Whether this action needs a connection, which the catalog answers for every
// action alike.
const requiresIntegration = (actionType: string): boolean =>
  Boolean(findAction(getExtensionCatalog(), actionType)?.integration);

// The logo an action wears on its node: a built-in's own glyph, its
// integration's icon, or a fallback.
const ProviderLogo = ({ actionType }: { actionType: string }) => {
  const integrationUi = useIntegrationUi();

  // Check for system actions first (non-plugin)
  switch (actionType) {
    case BUILT_IN_ACTION_IDS.condition:
      return (
        <GitBranch className="size-12 text-node-condition" strokeWidth={1.5} />
      );
    case BUILT_IN_ACTION_IDS.eventSplit:
      return <Split className="size-12 text-node-split" strokeWidth={1.5} />;
    case BUILT_IN_ACTION_IDS.wait:
      return <Hourglass className="size-12 text-node-wait" strokeWidth={1.5} />;
    default:
      // Not a built-in, so the icon comes from its integration below.
      break;
  }

  const integrationType = findAction(
    getExtensionCatalog(),
    actionType
  )?.integration;
  if (integrationType) {
    const ui = integrationUi[integrationType];
    if (ui) {
      const PluginIcon = ui.icon;
      return <PluginIcon className="size-12" />;
    }
  }

  return <Zap className="size-12 text-node-wait" strokeWidth={1.5} />;
};

const ModelBadge = ({ model }: { model: string }) => {
  if (!model) {
    return null;
  }

  return (
    <div className="rounded-full border border-muted-foreground/50 px-2 py-0.5 font-medium text-xs text-muted-foreground">
      {getModelDisplayName(model)}
    </div>
  );
};

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

/** Where one outlet's handle sits, as a percentage of the card's own width. */
function eventSplitOutletLeft(index: number, count: number): string {
  return `${((index + 0.5) / count) * 100}%`;
}

export const ActionNode = memo(({ data, selected, id }: ActionNodeProps) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const selectedExecutionId = useAtomValue(selectedExecutionIdAtom);
  const executionLogs = useExecutionLogsByNode();
  const {
    data: availableIntegrationIds = NO_INTEGRATION_IDS,
    isPending: isLoadingIntegrations,
  } = useQuery(integrationIdsQueryOptions());
  const integrationsLoaded = !isLoadingIntegrations;
  const nodeLog = executionLogs[id];
  const actionType = readConfigString(data?.config, "actionType");
  const isConditionAction = isConditionActionType(actionType);
  const isEventSplitAction = isEventSplitActionType(actionType);
  const splitOutlets = useEventSplitOutlets(isEventSplitAction ? id : null);
  const runtimeWaitPreview = useRuntimeWaitPreview(
    actionType ?? "",
    selectedExecutionId,
    nodeLog
  );
  const configWaitPreview = useWaitPreview(actionType ?? "", data?.config);
  const waitPreview = runtimeWaitPreview ?? configWaitPreview;

  // A condition node renders two source handles where every other node renders
  // one, and an Event Split renders one per Event that can reach it, which
  // changes as the graph above it does. React Flow caches handle positions and
  // has no way to notice either, so it has to be told.
  //
  // After paint, not during the commit. React Flow measures a node's handles in
  // its own commit-phase work, which for a node component runs after that
  // component's own effects; telling it from a passive effect lands too early
  // and the measurement it then takes is of the handles as they were. The
  // symptom is a condition node whose true and false handles are on screen and
  // draggable-looking, while React Flow still has only the single default
  // handle recorded and starts no connection from either.
  const splitOutletKey = isEventSplitAction
    ? splitOutlets.map((event) => event.name).join("|")
    : null;

  useAfterPaint(isConditionAction ? id : splitOutletKey, () => {
    if (isConditionAction || isEventSplitAction) {
      updateNodeInternals(id);
    }
  });

  if (!data) {
    return null;
  }

  const status = data.status;

  // A Generate Image step can return its image inline. When the run being viewed
  // produced one, the node shows it in place of the provider logo.
  const generatedImageBase64 =
    selectedExecutionId && actionType === "Generate Image"
      ? readBase64ImageOutput(nodeLog?.output)
      : null;

  if (!actionType) {
    const isDisabled = data.enabled === false;
    return (
      <Node
        className={cn(
          "flex size-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
          selected && "border-primary",
          isDisabled && "opacity-50"
        )}
        data-testid={`action-node-${id}`}
        handles={{ target: true, source: true }}
        status={status}
      >
        {isDisabled && (
          <div className="absolute top-2 left-2 rounded-full bg-muted-foreground/50 p-1">
            <EyeOff className="size-3.5 text-background" />
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

  const actionInfo = findAction(getExtensionCatalog(), actionType);
  const displayTitle = data.label || actionInfo?.label || actionType;
  const displayDescription =
    data.description || getIntegrationFromActionType(actionType);

  const needsIntegration = requiresIntegration(actionType);
  const configuredIntegrationId = readConfigString(
    data.config,
    "integrationId"
  );
  const hasValidIntegration =
    configuredIntegrationId &&
    availableIntegrationIds.has(configuredIntegrationId);
  // Wait for the connection list before claiming one is missing.
  const integrationMissing =
    integrationsLoaded && needsIntegration && !hasValidIntegration;

  const getAiModel = (): string | null => {
    if (actionType === "Generate Text") {
      return readConfigStringOr(data.config, "aiModel", "meta/llama-4-scout");
    }
    if (actionType === "Generate Image") {
      return readConfigStringOr(
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
        "relative flex size-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
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
          : isEventSplitAction
            ? splitOutlets.map((event, index) => ({
                id: eventSplitOutlet(event.name),
                position: Position.Bottom,
                style: {
                  left: eventSplitOutletLeft(index, splitOutlets.length),
                  width: 12,
                  height: 12,
                },
              }))
            : true,
      }}
      // A split is as wide as its outlets. Every other node keeps the width its
      // class names, which is what `undefined` leaves standing.
      style={
        isEventSplitAction && splitOutlets.length > 1
          ? { width: eventSplitCardWidth(splitOutlets.length) }
          : undefined
      }
      status={status}
    >
      {/* Disabled badge in top left */}
      {isDisabled && (
        <div className="absolute top-2 left-2 rounded-full bg-muted-foreground/50 p-1">
          <EyeOff className="size-3.5 text-background" />
        </div>
      )}

      {/* Integration warning badge in top left (only if not disabled) */}
      {!isDisabled && integrationMissing && (
        <div className="absolute top-2 left-2 rounded-full bg-warning/50 p-1">
          <AlertTriangle className="size-3.5 text-background" />
        </div>
      )}

      {isConditionAction && (
        <>
          <div className="pointer-events-none absolute -bottom-8 left-[38%] -translate-x-1/2 rounded-sm border bg-card px-1.5 py-0.5 text-xs text-muted-foreground leading-none">
            True
          </div>
          <div className="pointer-events-none absolute -bottom-8 left-[62%] -translate-x-1/2 rounded-sm border bg-card px-1.5 py-0.5 text-xs text-muted-foreground leading-none">
            False
          </div>
        </>
      )}

      {isEventSplitAction &&
        splitOutlets.map((event, index) => (
          <div
            className="pointer-events-none absolute -bottom-8 max-w-28 -translate-x-1/2 truncate rounded-sm border bg-card px-1.5 py-0.5 text-xs text-muted-foreground leading-none"
            key={event.name}
            style={{
              left: eventSplitOutletLeft(index, splitOutlets.length),
            }}
            title={event.name}
          >
            {event.label}
          </div>
        ))}

      <div className="flex flex-col items-center justify-center gap-3 p-6">
        {generatedImageBase64 ? (
          <GeneratedImageThumbnail base64={generatedImageBase64} />
        ) : (
          <ProviderLogo actionType={actionType} />
        )}
        <div className="flex flex-col items-center gap-1 text-center">
          <NodeTitle className="text-base">{displayTitle}</NodeTitle>
          {waitPreview ? (
            <div className="flex flex-col items-center gap-0.5">
              <NodeDescription className="font-medium text-xs tabular-nums">
                {waitPreview.countdown}
              </NodeDescription>
              <NodeDescription className="max-w-[10.5rem] text-xs leading-tight">
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
