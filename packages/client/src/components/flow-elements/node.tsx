import { Handle, Position, useStore } from "@xyflow/react";
import {
  Ban,
  Check,
  CircleSlash,
  Hourglass,
  Loader2,
  RotateCw,
  XCircle,
} from "lucide-react";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { AnimatedBorder } from "#src/components/ui/animated-border";
import { Card, CardTitle } from "#src/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#src/components/ui/tooltip";
import { stepRunStatusLabel } from "#src/components/workflow/workflow-run-shared";
import { isCompactCardZoom } from "#src/components/workflow/workflow-viewport";
import { NODE_COMPACT_TYPE_PX } from "#src/lib/workflow-node-dimensions";
import { useElementOverflow } from "#src/hooks/effects";
import { cn } from "@wfgraph/shared/utils";

export type NodeProps = ComponentProps<typeof Card> & {
  handles: {
    target: boolean | NodeHandleConfig[];
    source: boolean | NodeHandleConfig[];
  };
  status?:
    | "idle"
    | "running"
    | "waiting"
    | "retrying"
    | "success"
    | "error"
    | "cancelled"
    | undefined;
  /**
   * Whether a successful step did nothing because the run has Test
   * recipients. The card then keeps its resting border and its chip reads
   * "Skipped (test run)", so a green border never claims a send.
   */
  testSkipped?: boolean | undefined;
  selected?: boolean | undefined;
  /** The card side a `true` source handle sits on. Bottom when unset. */
  sourcePosition?: Position | undefined;
  /** The card side a `true` target handle sits on. Top when unset. */
  targetPosition?: Position | undefined;
  /**
   * Whether a connection can start or end on the card's handles, which is the
   * `isConnectable` React Flow gives the node component.
   */
  isConnectable: boolean;
};

// Run status is worn as a border color, which a colorblind user cannot read and
// a screen reader cannot see at all. This chip is the text equivalent: every
// non-idle status renders its word next to its icon, in the words
// `stepRunStatusLabel` gives every surface that names a step's run status,
// and the whole thing is a live region so status transitions are announced.
// The tint and the icon carry the signal and the word is foreground text,
// because a signal's text on its own tint measures under 4.5:1. `skipped` is
// a successful step a test run did nothing at, which claims no signal.
const STATUS_CHIP = {
  skipped: {
    Icon: CircleSlash,
    className: "bg-muted",
    iconClassName: "text-muted-foreground",
  },
  running: {
    Icon: Loader2,
    className: "bg-primary/5",
    iconClassName: "animate-spin text-info motion-reduce:animate-none",
  },
  waiting: {
    Icon: Hourglass,
    className: "bg-warning/10",
    iconClassName: "text-warning",
  },
  retrying: {
    Icon: RotateCw,
    className: "bg-warning/10",
    iconClassName: "text-warning",
  },
  success: {
    Icon: Check,
    className: "bg-success/10",
    iconClassName: "text-success",
  },
  error: {
    Icon: XCircle,
    className: "bg-destructive/10",
    iconClassName: "text-destructive",
  },
  cancelled: {
    Icon: Ban,
    className: "bg-cancelled/10",
    iconClassName: "text-cancelled",
  },
} as const;

// The chip straddles the card's top edge, half above the card, so it never
// shares a box with the type icon centred inside. It lives in the strip from
// just right of the top handle (the handle is 12px wide and centred) to the
// card's right inset, aligned to the right. A chip wider than that strip, such
// as "Skipped (test run)" on a 192px card, starts just right of the handle and
// runs past the card's right edge into the gap between siblings, because
// `justify-end-safe` overflows toward the end. The card fill under the tint
// keeps the border from showing through the chip.
const NodeStatusChip = ({
  status,
  testSkipped,
}: {
  status?: NodeProps["status"];
  testSkipped: boolean;
}) => {
  if (!status || status === "idle") {
    return null;
  }

  const chip = STATUS_CHIP[testSkipped ? "skipped" : status];
  return (
    <div className="pointer-events-none absolute top-0 right-2 left-[calc(50%+10px)] z-10 flex -translate-y-1/2 justify-end-safe">
      <div className="shrink-0 rounded-sm bg-card" role="status">
        <div
          className={cn(
            "flex items-center gap-1 whitespace-nowrap rounded-sm py-0.5 pr-2 pl-1.5 font-medium text-foreground text-xs leading-none",
            chip.className
          )}
        >
          <chip.Icon
            className={cn("size-3", chip.iconClassName)}
            strokeWidth={2.5}
          />
          {stepRunStatusLabel(status, testSkipped).text}
        </div>
      </div>
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
  config: boolean | NodeHandleConfig[],
  position: Position,
  isConnectable: boolean
): ReactNode {
  if (config === false) {
    return null;
  }

  if (config === true) {
    return (
      <Handle
        aria-label={handleType === "source" ? "Output handle" : "Input handle"}
        isConnectable={isConnectable}
        isConnectableEnd={isConnectable}
        isConnectableStart={isConnectable}
        position={position}
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
        isConnectable={isConnectable}
        isConnectableEnd={isConnectable}
        isConnectableStart={isConnectable}
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
  testSkipped = false,
  sourcePosition = Position.Bottom,
  targetPosition = Position.Top,
  isConnectable,
  ...props
}: NodeProps) => (
  <Card
    className={cn(
      // The resting border is heavier and darker than Card's hairline: a node is
      // Paper on a Paper canvas, so this stroke is the whole card edge. Status
      // still steps up to 2px below, so a run reads as a change in weight and
      // not only in colour.
      "node-container relative flex flex-col items-center justify-center gap-0 overflow-visible rounded-md border-[1.5px] border-canvas-line bg-card p-0 shadow-none transition-[background-color,border-color,opacity] duration-150 ease-out",
      status === "success" && !testSkipped && "border-2 border-success",
      status === "error" && "border-2 border-destructive",
      status === "cancelled" && "border-2 border-cancelled",
      className
    )}
    data-selected={selected}
    {...props}
  >
    {status === "running" && <AnimatedBorder />}
    <NodeStatusChip
      status={status}
      testSkipped={testSkipped && status === "success"}
    />
    {renderHandles("target", handles.target, targetPosition, isConnectable)}
    {renderHandles("source", handles.source, sourcePosition, isConnectable)}
    {props.children}
  </Card>
);

export type NodeTitleProps = ComponentProps<typeof CardTitle>;

export const NodeTitle = ({
  children,
  className,
  title,
  ...props
}: NodeTitleProps) => (
  <CardTitle
    className={cn(
      "w-full text-sm leading-tight",
      "line-clamp-2 text-balance [overflow-wrap:anywhere]",
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
          className="block max-w-[min(20rem,calc(100vw-2rem))] whitespace-pre-wrap [overflow-wrap:anywhere]"
          role="tooltip"
        >
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

/**
 * Whether cards draw their compact form at the canvas's current zoom. The
 * selector maps the zoom to a boolean, so a card re-renders when the zoom
 * crosses `WORKFLOW_COMPACT_CARD_ZOOM` and never on the frames between.
 */
export function useCompactCard(): boolean {
  return useStore((state) => isCompactCardZoom(state.transform[2]));
}

/**
 * A step's number in run order, set before its title on a full card and
 * beside it on a compact one. Nothing draws when the step has no number.
 */
export const NodeStepNumber = ({
  value,
  className,
}: {
  value: number | undefined;
  className?: string | undefined;
}) =>
  value === undefined ? null : (
    <span
      className={cn(
        "font-medium text-muted-foreground tabular-nums",
        className
      )}
      data-slot="node-step-number"
    >
      {value}
    </span>
  );

/**
 * The whole content of a card in its compact form: `lead`, which is the
 * step's number or a glyph standing in for one, beside the title in type
 * that reads at the zoom fitting a whole workflow. The card keeps its size,
 * so its handles, connections and hit area stay where they are. The top
 * padding keeps the title clear of the run status chip on the top edge.
 */
export const NodeCompactBody = ({
  lead,
  title,
  className,
}: {
  lead: ReactNode;
  title: string;
  className?: string | undefined;
}) => (
  <div
    className={cn(
      "flex w-full min-w-0 items-center gap-2 px-3 pt-3.5 pb-2 text-left leading-[1.15]",
      className
    )}
    data-slot="node-compact-body"
    style={{ fontSize: NODE_COMPACT_TYPE_PX }}
  >
    {lead}
    <span
      className="line-clamp-3 min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]"
      title={title}
    >
      {title}
    </span>
  </div>
);

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
