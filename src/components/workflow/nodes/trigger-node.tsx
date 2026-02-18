import type { NodeProps } from "@xyflow/react";
import cronstrue from "cronstrue";
import { Ban, Check, Clock, Play, Webhook, XCircle } from "lucide-react";
import { memo } from "react";
import type { WorkflowNodeData } from "@/client/lib/workflow-store";
import {
  Node,
  NodeDescription,
  NodeTitle,
} from "@/components/flow-elements/node";
import { cn } from "@/shared/utils";
import { parseScheduleExpression } from "@/shared/utils/schedule-expression";

type TriggerNodeProps = NodeProps & {
  data?: WorkflowNodeData;
};

function getScheduleSummary(
  triggerType: string,
  scheduleExpression: string,
  scheduleCron: string,
  scheduleTimezone: string
): string {
  if (triggerType !== "Schedule") {
    return "";
  }

  const resolved = parseScheduleExpression(scheduleExpression || scheduleCron);
  if (!resolved?.cron) {
    return "Set a cron expression";
  }

  try {
    const description = cronstrue.toString(resolved.cron, { verbose: true });
    return scheduleTimezone
      ? `${description} (${scheduleTimezone})`
      : description;
  } catch {
    return "Invalid cron expression";
  }
}

function TriggerStatusBadge({
  status,
}: {
  status: WorkflowNodeData["status"];
}) {
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
}

function renderTriggerIcon(triggerType: string) {
  if (triggerType === "Schedule") {
    return <Clock className="size-12 text-blue-500" strokeWidth={1.5} />;
  }

  if (triggerType === "Webhook") {
    return <Webhook className="size-12 text-blue-500" strokeWidth={1.5} />;
  }

  return <Play className="size-12 text-blue-500" strokeWidth={1.5} />;
}

export const TriggerNode = memo(({ data, selected }: TriggerNodeProps) => {
  if (!data) {
    return null;
  }

  const triggerType =
    typeof data.config?.triggerType === "string"
      ? data.config.triggerType
      : "Webhook";
  const displayTitle = data.label || triggerType;
  const scheduleExpression =
    typeof data.config?.scheduleExpression === "string"
      ? data.config.scheduleExpression.trim()
      : "";
  const scheduleCron =
    typeof data.config?.scheduleCron === "string"
      ? data.config.scheduleCron.trim()
      : "";
  const scheduleTimezone =
    typeof data.config?.scheduleTimezone === "string"
      ? data.config.scheduleTimezone.trim()
      : "";
  const scheduleSummary = getScheduleSummary(
    triggerType,
    scheduleExpression,
    scheduleCron,
    scheduleTimezone
  );
  const displayDescription =
    data.description ||
    (triggerType === "Schedule" ? "Schedule trigger" : "Trigger");
  const status = data.status;

  return (
    <Node
      className={cn(
        "flex h-48 w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
        selected && "border-primary"
      )}
      handles={{ target: false, source: true }}
      status={status}
    >
      <TriggerStatusBadge status={status} />

      <div className="flex flex-col items-center justify-center gap-3 p-6">
        {renderTriggerIcon(triggerType)}
        <div className="flex flex-col items-center gap-1 text-center">
          <NodeTitle className="text-base">{displayTitle}</NodeTitle>
          {displayDescription && (
            <NodeDescription className="text-xs">
              {displayDescription}
            </NodeDescription>
          )}
          {scheduleSummary ? (
            <p className="max-w-40 text-[11px] text-muted-foreground leading-tight">
              {scheduleSummary}
            </p>
          ) : null}
        </div>
      </div>
    </Node>
  );
});

TriggerNode.displayName = "TriggerNode";
