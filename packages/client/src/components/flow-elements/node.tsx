import { Handle, Position } from "@xyflow/react";
import { Ban, Check, Loader2, XCircle } from "lucide-react";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { AnimatedBorder } from "@/components/ui/animated-border";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { cn } from "@rova/shared/utils";

export type NodeProps = ComponentProps<typeof Card> & {
  handles: {
    target: boolean | NodeHandleConfig[];
    source: boolean | NodeHandleConfig[];
  };
  status?: "idle" | "running" | "success" | "error" | "cancelled";
};

// Run status is worn as a border color, which a colorblind user cannot read and
// a screen reader cannot see at all. This chip is the text equivalent: every
// non-idle status renders its word next to its icon, and the whole thing is a
// live region so status transitions are announced.
const STATUS_CHIP = {
  running: {
    label: "Running",
    Icon: Loader2,
    className: "bg-primary/5 text-foreground",
    iconClassName: "animate-spin motion-reduce:animate-none",
  },
  success: {
    label: "Succeeded",
    Icon: Check,
    className: "bg-green-500/10 text-green-700 dark:text-green-400",
    iconClassName: "",
  },
  error: {
    label: "Failed",
    Icon: XCircle,
    className: "bg-red-500/10 text-red-700 dark:text-red-400",
    iconClassName: "",
  },
  cancelled: {
    label: "Cancelled",
    Icon: Ban,
    className: "bg-slate-500/10 text-slate-700 dark:text-slate-400",
    iconClassName: "",
  },
} as const;

const NodeStatusChip = ({ status }: { status?: NodeProps["status"] }) => {
  if (!status || status === "idle") {
    return null;
  }

  const chip = STATUS_CHIP[status];
  return (
    <div
      className={cn(
        "absolute top-2 right-2 z-10 flex items-center gap-1 rounded-full py-0.5 pr-2 pl-1.5 font-medium text-[10px] leading-none",
        chip.className
      )}
      role="status"
    >
      <chip.Icon
        className={cn("size-3", chip.iconClassName)}
        strokeWidth={2.5}
      />
      {chip.label}
    </div>
  );
};

type NodeHandleConfig = {
  id?: string;
  position: Position;
  style?: CSSProperties;
};

function renderHandles(
  handleType: "source" | "target",
  config: boolean | NodeHandleConfig[]
): ReactNode {
  if (config === false) {
    return null;
  }

  if (config === true) {
    return (
      <Handle
        position={handleType === "source" ? Position.Bottom : Position.Top}
        type={handleType}
      />
    );
  }

  return config.map((handleConfig) => {
    const fallbackKey = [
      handleType,
      handleConfig.position,
      handleConfig.style?.top,
      handleConfig.style?.right,
      handleConfig.style?.bottom,
      handleConfig.style?.left,
    ].join(":");

    return (
      <Handle
        id={handleConfig.id}
        key={handleConfig.id ?? fallbackKey}
        position={handleConfig.position}
        style={handleConfig.style}
        type={handleType}
      />
    );
  });
}

export const Node = ({ handles, className, status, ...props }: NodeProps) => (
  <Card
    className={cn(
      "node-container relative size-full h-auto w-sm gap-0 overflow-visible rounded-md bg-card p-0 transition-all duration-200",
      status === "success" && "border-2 border-green-500",
      status === "error" && "border-2 border-red-500",
      status === "cancelled" && "border-2 border-slate-500",
      className
    )}
    {...props}
  >
    {status === "running" && <AnimatedBorder />}
    <NodeStatusChip status={status} />
    {renderHandles("target", handles.target)}
    {renderHandles("source", handles.source)}
    {props.children}
  </Card>
);

export type NodeTitleProps = ComponentProps<typeof CardTitle>;

export const NodeTitle = (props: NodeTitleProps) => <CardTitle {...props} />;

export type NodeDescriptionProps = ComponentProps<typeof CardDescription>;

export const NodeDescription = (props: NodeDescriptionProps) => (
  <CardDescription {...props} />
);
