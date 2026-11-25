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
import {
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AnimatedBorder } from "#src/components/ui/animated-border";
import { Card, CardTitle } from "#src/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#src/components/ui/tooltip";
import { stepRunStatusLabel } from "#src/components/workflow/workflow-run-shared";
import {
  type CardTier,
  cardTierAtZoom,
} from "#src/components/workflow/workflow-viewport";
import {
  COMPACT_MARK_PX,
  COMPACT_TITLE_BOX,
  COMPACT_TITLE_LINE_HEIGHT,
  type CompactTitleFit,
  fitCompactTitle,
  hasSmallerTitleSize,
  measureCompactTitle,
} from "#src/components/flow-elements/compact-card";
import { useBeforePaint, useElementOverflow } from "#src/hooks/effects";
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
  /**
   * Whether the card draws its compact form, where the run status shows as a
   * mark inside the card's top-right corner in place of the chip.
   */
  compact?: boolean | undefined;
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

/**
 * The run status on a compact card: the chip's icon at the compact type size
 * inside the card's top-right corner, where it reads at 11px or more when the
 * whole workflow is fitted. The word stays in the accessible name and the
 * tooltip, and the border carries the outcome as it does on a full card.
 */
export const NodeStatusMark = ({
  status,
  testSkipped,
  placement = "corner",
}: {
  status?: NodeProps["status"];
  testSkipped: boolean;
  /** "corner" inside a card's top-right corner, "inline" in a row of marks. */
  placement?: "corner" | "inline" | undefined;
}) => {
  if (!status || status === "idle") {
    return null;
  }
  const chip = STATUS_CHIP[testSkipped ? "skipped" : status];
  const label = stepRunStatusLabel(status, testSkipped).text;
  return (
    <div
      aria-label={label}
      className={cn(
        "pointer-events-none rounded-full bg-card",
        placement === "corner" ? "absolute top-1.5 right-2 z-10" : "shrink-0"
      )}
      data-slot="node-status-mark"
      role="status"
      title={label}
    >
      <chip.Icon
        aria-hidden="true"
        className={chip.iconClassName}
        strokeWidth={2.5}
        style={{ width: COMPACT_MARK_PX, height: COMPACT_MARK_PX }}
      />
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
  compact = false,
  ...props
}: NodeProps) => (
  <Card
    className={cn(
      // The resting border is heavier and darker than Card's hairline: a node is
      // Paper on a Paper canvas, so this stroke is the whole card edge. It is
      // held at 2px on screen as the canvas zooms out (`--canvas-stroke`), and
      // status steps up to `--canvas-stroke-heavy`, so a run reads as a change
      // in weight and not only in colour.
      "node-container relative flex flex-col items-center justify-center gap-0 overflow-visible rounded-md border-(length:--canvas-stroke) border-canvas-line bg-card p-0 shadow-none transition-[background-color,border-color,opacity] duration-150 ease-out",
      status === "success" &&
        !testSkipped &&
        "border-(length:--canvas-stroke-heavy) border-success",
      status === "error" &&
        "border-(length:--canvas-stroke-heavy) border-destructive",
      status === "cancelled" &&
        "border-(length:--canvas-stroke-heavy) border-cancelled",
      className
    )}
    data-selected={selected}
    {...props}
  >
    {status === "running" && <AnimatedBorder />}
    {compact ? (
      <NodeStatusMark
        status={status}
        testSkipped={testSkipped && status === "success"}
      />
    ) : (
      <NodeStatusChip
        status={status}
        testSkipped={testSkipped && status === "success"}
      />
    )}
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
 * The form cards draw at the canvas's current zoom. The selector maps the zoom
 * to one of three values, so a card re-renders when the zoom crosses
 * `WORKFLOW_COMPACT_CARD_ZOOM` or `WORKFLOW_NUMBER_CARD_ZOOM` and never on the
 * frames between.
 */
export function useCardTier(): CardTier {
  return useStore((state) => cardTierAtZoom(state.transform[2]));
}

/**
 * Whether cards draw less than the full card, compact or by number alone, for
 * the captions and labels that only the full card has room to show.
 */
export function useCompactCard(): boolean {
  return useStore((state) => cardTierAtZoom(state.transform[2]) !== "full");
}

/** The type size of a card's lead row at each tier, in canvas pixels. */
const LEAD_PX: Readonly<Record<CardTier, number>> = {
  full: 14,
  compact: COMPACT_MARK_PX,
  number: COMPACT_MARK_PX,
};

/**
 * The class a kind's glyph wears in a card's lead row, sized against the
 * row's type so it grows with the tier.
 */
export const LEAD_GLYPH_CLASS = "size-[1.15em] shrink-0";

/**
 * A step's number in run order, in a card's lead row or a Group header.
 * Nothing draws when the step has no number.
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
      className={cn("font-medium tabular-nums", className)}
      data-slot="node-step-number"
    >
      {value}
    </span>
  );

/**
 * A card's content, one anatomy at every tier. The lead row holds the kind's
 * `glyph`, the step's number when it has one, and `marks` such as the issue
 * badge, in that order at every zoom. It sits in the top-left corner while a
 * title follows it. The full card adds the title and `description` below it;
 * the compact card keeps the title at the size `fitCompactTitle` finds; the
 * number tier keeps the lead row alone, centred in the card, which
 * `globals.css` holds at 18px on screen so the number is what the card says. The run
 * status stays in the card's top-right corner, as a chip on the full card and
 * a mark below it. The card keeps its size, so its handles, connections and
 * hit area stay where they are.
 */
export const NodeContent = ({
  tier,
  glyph,
  value,
  marks,
  title,
  description,
}: {
  tier: CardTier;
  glyph: ReactNode;
  value: number | undefined;
  marks?: ReactNode;
  title: string;
  description?: ReactNode;
}) => (
  <div
    className={cn(
      "flex h-full w-full min-w-0 flex-col text-left",
      tier === "full" ? "gap-1 px-3 py-2" : "px-3 py-1",
      tier === "number" && "justify-center"
    )}
    data-slot="node-content"
  >
    <div
      className={cn(
        "flex shrink-0 items-center gap-1.5 leading-none",
        tier === "number" && "justify-center"
      )}
      data-slot="node-lead"
      style={{
        fontSize: LEAD_PX[tier],
        height: tier === "full" ? undefined : COMPACT_MARK_PX + 2,
      }}
    >
      {glyph}
      <NodeStepNumber value={value} />
      {marks}
    </div>
    {tier === "full" ? (
      <div className="flex min-h-0 flex-1 flex-col justify-center gap-1">
        <NodeTitle title={title}>
          {title}
        </NodeTitle>
        {description}
      </div>
    ) : tier === "compact" ? (
      <NodeCompactTitle title={title} />
    ) : null}
  </div>
);

let fontsLoaded =
  typeof document === "undefined" || document.fonts?.status !== "loading";
const fontListeners = new Set<() => void>();
/** Each compact title's fit, by title, measured in the fonts loaded so far. */
const titleFits = new Map<string, CompactTitleFit>();
if (!fontsLoaded) {
  void document.fonts.ready.then(() => {
    fontsLoaded = true;
    titleFits.clear();
    for (const listener of fontListeners) {
      listener();
    }
  });
}
function subscribeToFonts(listener: () => void): () => void {
  fontListeners.add(listener);
  return () => fontListeners.delete(listener);
}

/** The line clamp for each number of lines a compact title can take. */
const TITLE_LINE_CLAMP: Readonly<Record<number, string>> = {
  2: "line-clamp-2",
  3: "line-clamp-3",
  4: "line-clamp-4",
};

/**
 * A compact card's title, below its lead row. It takes the card's full width
 * at the largest size `fitCompactTitle` finds where it breaks only between
 * words. The title is measured again once the page's fonts finish loading.
 */
const NodeCompactTitle = ({ title }: { title: string }) => {
  // Subscribed so the card draws again, and measures again, once the page's
  // fonts finish loading.
  useSyncExternalStore(subscribeToFonts, () => fontsLoaded, () => true);
  const titleRef = useRef<HTMLSpanElement>(null);
  // How many of the largest sizes the page's own layout ruled out, for a
  // title the measure said would fit but that the page broke onto more lines.
  const [skippedSizes, setSkippedSizes] = useState(0);
  let fit = skippedSizes === 0 ? titleFits.get(title) : undefined;
  if (fit === undefined) {
    fit = fitCompactTitle(title, measureCompactTitle, skippedSizes);
    if (skippedSizes === 0) {
      titleFits.set(title, fit);
    }
  }
  // The page is the authority on where lines break: a clamped title whose
  // content runs past its box steps down a size before the card is painted,
  // so a title that fits three lines at a smaller size never ends early.
  useBeforePaint(`${title}|${fit.fontPx}|${fit.maxLines}`, () => {
    const element = titleRef.current;
    if (
      element !== null &&
      element.scrollHeight > element.clientHeight + 1 &&
      hasSmallerTitleSize(skippedSizes)
    ) {
      setSkippedSizes(skippedSizes + 1);
    }
  });
  return (
    <div
      className="flex min-h-0 flex-1 items-center"
      style={{ maxHeight: COMPACT_TITLE_BOX.height }}
    >
      <span
        className={cn(
          "w-full overflow-hidden font-medium [overflow-wrap:normal] [word-break:normal]",
          TITLE_LINE_CLAMP[fit.maxLines] ?? "line-clamp-3"
        )}
        data-slot="node-compact-title"
        lang="en"
        ref={titleRef}
        style={{
          fontSize: fit.fontPx,
          lineHeight: COMPACT_TITLE_LINE_HEIGHT,
          hyphens: fit.hyphenate ? "auto" : "manual",
        }}
        title={title}
      >
        {title}
      </span>
    </div>
  );
};
