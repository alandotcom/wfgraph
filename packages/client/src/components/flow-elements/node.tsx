import { Handle, Position } from "@xyflow/react";
import { Ban, Check, Loader2, XCircle } from "lucide-react";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { AnimatedBorder } from "#src/components/ui/animated-border";
import { Card, CardTitle } from "#src/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#src/components/ui/tooltip";
import { useElementOverflow } from "#src/hooks/effects";
import { cn } from "@wfgraph/shared/utils";

export type NodeProps = ComponentProps<typeof Card> & {
  handles: {
    target: boolean | NodeHandleConfig[];
    source: boolean | NodeHandleConfig[];
  };
  status?: "idle" | "running" | "success" | "error" | "cancelled" | undefined;
  selected?: boolean | undefined;
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
  id?: string | undefined;
  label?: string | undefined;
  position: Position;
  style?: CSSProperties | undefined;
  className?: string | undefined;
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
        aria-label={handleType === "source" ? "Output handle" : "Input handle"}
        position={handleType === "source" ? Position.Bottom : Position.Top}
        role="img"
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
        aria-label={
          handleConfig.label ??
          (handleType === "source" ? "Output handle" : "Input handle")
        }
        className={handleConfig.className}
        // React Flow's `id` prop takes a string or `null`, not `undefined`.
        id={handleConfig.id ?? null}
        key={handleConfig.id ?? fallbackKey}
        position={handleConfig.position}
        role="img"
        style={handleConfig.style}
        type={handleType}
      />
    );
  });
}

export const Node = ({
  handles,
  className,
  selected = false,
  status,
  ...props
}: NodeProps) => (
  <Card
    className={cn(
      // The resting border is heavier and darker than Card's hairline: a node is
      // Paper on a Paper canvas, so this stroke is the whole card edge. Status
      // still steps up to 2px below, so a run reads as a change in weight and
      // not only in colour.
      "node-container relative flex flex-col items-center justify-center gap-0 overflow-visible rounded-md border-[1.5px] border-canvas-line bg-card p-0 shadow-none transition-[background-color,border-color,opacity] duration-150 ease-out",
      status === "success" && "border-2 border-success",
      status === "error" && "border-2 border-destructive",
      status === "cancelled" && "border-2 border-cancelled",
      className
    )}
    data-selected={selected}
    {...props}
  >
    {status === "running" && <AnimatedBorder />}
    <NodeStatusChip status={status} />
    {renderHandles("target", handles.target)}
    {renderHandles("source", handles.source)}
    {props.children}
  </Card>
);

export type NodeTitleProps = ComponentProps<typeof CardTitle> & {
  /** Compact Group members have one text line; full-size nodes can use two. */
  singleLine?: boolean | undefined;
};

export const NodeTitle = ({
  children,
  className,
  singleLine = false,
  title,
  ...props
}: NodeTitleProps) => (
  <CardTitle
    className={cn(
      "w-full text-sm leading-tight",
      singleLine
        ? "truncate"
        : "line-clamp-2 text-balance [overflow-wrap:anywhere]",
      className
    )}
    title={title ?? (typeof children === "string" ? children : undefined)}
    {...props}
  >
    {children}
  </CardTitle>
);

export type NodeDescriptionProps = ComponentProps<"div">;

export const NodeDescription = ({
  className,
  children,
  ...props
}: NodeDescriptionProps) => {
  const hasDescription =
    children !== null && children !== undefined && children !== "";
  const { ref, overflowing } = useElementOverflow({
    enabled: hasDescription,
    key: children,
  });
  const isTooltipTrigger = hasDescription && overflowing;
  const description = (
    <div
      className={cn(
        "workflow-node-description nodrag nowheel block w-full truncate text-xs/relaxed text-muted-foreground",
        className
      )}
      ref={hasDescription ? ref : undefined}
      tabIndex={isTooltipTrigger ? 0 : undefined}
      {...props}
    >
      {children}
    </div>
  );

  if (!isTooltipTrigger) {
    return description;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={description} />
        <TooltipContent
          className="max-w-[min(20rem,calc(100vw-2rem))] whitespace-pre-wrap break-words"
          role="tooltip"
        >
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

// `text-center` is what centres the words. The title and description are
// full-width blocks, so `items-center` reaches only the icon, the one child
// narrower than the stack.
export const NodeBody = ({ className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn(
      "flex w-full flex-col items-center justify-center gap-1 px-3 py-2 text-center",
      className
    )}
    {...props}
  />
);
