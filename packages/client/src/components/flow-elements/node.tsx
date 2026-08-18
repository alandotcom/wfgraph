import { Handle, Position } from "@xyflow/react";
import { Ban, Check, Loader2, XCircle } from "lucide-react";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { AnimatedBorder } from "#src/components/ui/animated-border";
import { Card, CardDescription, CardTitle } from "#src/components/ui/card";
import { cn } from "@wfgraph/shared/utils";

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
    className: "bg-success/10 text-success",
    iconClassName: "",
  },
  error: {
    label: "Failed",
    Icon: XCircle,
    className: "bg-destructive/10 text-destructive",
    iconClassName: "",
  },
  cancelled: {
    label: "Cancelled",
    Icon: Ban,
    className: "bg-cancelled/10 text-cancelled",
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
        "absolute top-2 right-2 z-10 flex items-center gap-1 rounded-sm py-0.5 pr-2 pl-1.5 font-medium text-xs leading-none",
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
  className?: string;
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
        className={handleConfig.className}
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
      // The resting border is heavier and darker than Card's hairline: a node is
      // Paper on a Paper canvas, so this stroke is the whole card edge. Status
      // still steps up to 2px below, so a run reads as a change in weight and
      // not only in colour.
      "node-container relative flex flex-col items-center justify-center gap-0 overflow-visible rounded-md border-[1.5px] border-canvas-line bg-card p-0 shadow-none transition-all duration-150 ease-out",
      status === "success" && "border-2 border-success",
      status === "error" && "border-2 border-destructive",
      status === "cancelled" && "border-2 border-cancelled",
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

export const NodeTitle = ({ className, ...props }: NodeTitleProps) => (
  <CardTitle className={cn("w-full truncate text-base", className)} {...props} />
);

export type NodeDescriptionProps = ComponentProps<typeof CardDescription>;

export const NodeDescription = ({
  className,
  ...props
}: NodeDescriptionProps) => (
  <CardDescription
    className={cn("w-full truncate text-xs", className)}
    {...props}
  />
);

// `text-center` is what centres the words. The title and description are
// full-width truncating blocks, so `items-center` reaches only the icon, the one
// child narrower than the stack.
export const NodeBody = ({ className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn(
      "flex w-full flex-col items-center justify-center gap-1 px-3 py-2 text-center",
      className
    )}
    {...props}
  />
);

