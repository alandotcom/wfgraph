/**
 * The build agent's panel: a dismissible card over the canvas and the button
 * that opens it.
 *
 * Expanding does not animate the card's box. Docked it is `absolute` on the
 * canvas and expanded it is `fixed` over the editor, and motion's `layout`
 * tweens between two boxes by scaling, which stretches every glyph in the
 * thread while it runs. The backdrop's fade is what carries the change.
 *
 * The user watches the graph change while they talk to the agent, so the panel
 * leaves the canvas at full width and can be resized when it covers too much.
 * Expanded it covers the editor instead, for a long turn worth reading whole.
 *
 * Absent entirely when the host configured no model: the runtime says so, and a
 * disabled control the user cannot enable is worse than no control.
 */

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { motion, useReducedMotion } from "motion/react";
import {
  Minimize2Icon,
  Maximize2Icon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useRef, useState } from "react";
import { cn } from "@wfgraph/shared/utils";
import { AgentThread } from "#src/components/agent/agent-thread";
import { useAgentRuntime } from "#src/components/agent/use-agent-runtime";
import { Button } from "#src/components/ui/button";
import { useDomEvent, useFocusTrap } from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import { can } from "#src/lib/authorization";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import {
  type AgentPanelSize,
  agentPanelSizeAtom,
  isAgentPanelExpandedAtom,
  isAgentPanelOpenAtom,
  isGeneratingAtom,
} from "#src/lib/workflow-ui-store";

/** How far one arrow key moves the panel's edge. */
const KEYBOARD_RESIZE_STEP = 24;

/**
 * The grip on the card's top-right corner.
 *
 * A drag reports a delta per frame and the size is persisted once at the end,
 * because the setter writes a cookie and a drag produces one event per frame.
 *
 * Arrow keys resize too. The editor is held to WCAG AA, and a control that only
 * answers a pointer is one a keyboard user cannot reach at all.
 *
 * 24px square, which is the pointer target WCAG 2.2 asks for, and inside the
 * card rather than over its corner, because the card clips its overflow. The
 * header keeps its right padding clear of that square so the two never overlap,
 * and the mark inside is what makes the control findable at all.
 */
function ResizeGrip({
  onResize,
  onResizeEnd,
}: {
  onResize: (delta: { x: number; y: number }) => void;
  onResizeEnd: () => void;
}) {
  const origin = useRef<{ x: number; y: number } | null>(null);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const start = origin.current;
      if (!start) {
        return;
      }
      onResize({ x: event.clientX - start.x, y: start.y - event.clientY });
      origin.current = { x: event.clientX, y: event.clientY };
    },
    [onResize]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const delta = {
        ArrowRight: { x: KEYBOARD_RESIZE_STEP, y: 0 },
        ArrowLeft: { x: -KEYBOARD_RESIZE_STEP, y: 0 },
        ArrowUp: { x: 0, y: KEYBOARD_RESIZE_STEP },
        ArrowDown: { x: 0, y: -KEYBOARD_RESIZE_STEP },
      }[event.key];

      if (!delta) {
        return;
      }

      event.preventDefault();
      onResize(delta);
      onResizeEnd();
    },
    [onResize, onResizeEnd]
  );

  return (
    <button
      aria-label="Resize the agent panel"
      className="group absolute top-0 right-0 flex size-6 cursor-nesw-resize items-start justify-end rounded-tr-xl p-1.5 focus-visible:ring-2 focus-visible:ring-ring/30"
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        origin.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => {
        origin.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onResizeEnd();
      }}
      type="button"
    >
      <span
        aria-hidden
        className="size-1.5 rounded-full bg-muted-foreground/30 transition-colors group-hover:bg-muted-foreground/70 group-focus-visible:bg-muted-foreground/70"
      />
    </button>
  );
}

function AgentCard({ onClose }: { onClose: () => void }) {
  const [size, setSize] = useAtom(agentPanelSizeAtom);
  const [dragged, setDragged] = useState<AgentPanelSize | null>(null);
  const [isExpanded, setIsExpanded] = useAtom(isAgentPanelExpandedAtom);
  const isGenerating = useAtomValue(isGeneratingAtom);
  const isMobile = useIsMobile();
  const prefersReducedMotion = useReducedMotion();
  const card = useRef<HTMLDivElement>(null);

  // Only the expanded card is modal. Its backdrop takes every pointer event, so
  // leaving the editor behind it in the tab order would offer a keyboard user
  // 36 controls they cannot click. Docked, the panel is one thing on the canvas
  // beside the rest of the editor and traps nothing.
  useFocusTrap(card, isExpanded);

  // While a drag is in flight the size lives here; the stored one is written on
  // release, because writing it is what writes the cookie.
  const shown = dragged ?? size;

  const onResize = useCallback(
    (delta: { x: number; y: number }) => {
      setDragged((current) => {
        const from = current ?? size;
        return { width: from.width + delta.x, height: from.height + delta.y };
      });
    },
    [size]
  );

  const onResizeEnd = useCallback(() => {
    setDragged((current) => {
      if (current) {
        setSize(current);
      }
      return null;
    });
  }, [setSize]);

  // Escape puts the card back on the canvas rather than closing the panel: the
  // agent may be mid-turn, and losing the conversation is not what a reader
  // dismissing an overlay is asking for.
  useDomEvent(
    window,
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        setIsExpanded(false);
      }
    },
    { enabled: isExpanded }
  );

  // Expanded, the card takes its box from the inset classes, so the dragged
  // size stops applying.
  const measured = isExpanded
    ? undefined
    : isMobile
      ? { height: Math.min(shown.height, 420) }
      : shown;

  return (
    <>
      {isExpanded && (
        // Dimming what the panel covers, and a click anywhere on it puts the
        // card back on the canvas. Out of the accessibility tree: the header's
        // collapse button carries that name already, and Escape does the same
        // thing from the keyboard.
        <motion.button
          animate={{ opacity: 1 }}
          aria-hidden
          className="pointer-events-auto fixed inset-0 z-10 cursor-default bg-foreground/40"
          initial={{ opacity: 0 }}
          onClick={() => setIsExpanded(false)}
          tabIndex={-1}
          transition={{ duration: prefersReducedMotion ? 0 : 0.2 }}
          type="button"
        />
      )}
      <div
        aria-label="Build agent"
        aria-modal={isExpanded}
        className={cn(
          "pointer-events-auto relative z-20 flex flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10",
          // The stored size is a preference carried in a cookie across machines
          // and windows, and the card is anchored to the bottom of the canvas
          // and grows upward, so a height this window cannot give it would push
          // the card's own header and close button off the top of the screen.
          // A max in CSS clamps what is drawn without touching what is stored,
          // so a smaller window is recoverable and the preference survives it.
          "max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)]",
          // Expanded, the card is centred and held to a reading width rather
          // than stretched over the whole editor, because the thread inside is
          // one column of prose. Centred by `mx-auto` between two zero insets
          // rather than by a half translate: a percentage translate lands on a
          // half pixel whenever the viewport width is odd, and every glyph in
          // the card then rasterizes off the pixel grid and reads as blurred.
          //
          // It is positioned against the editor shell rather than this
          // container: the shell sets a `clip-path` from `md` up, and a clip
          // path makes an element the containing block for its fixed
          // descendants. Anyone removing that clip path needs to know the card
          // reads it.
          isExpanded &&
            "fixed inset-x-0 inset-y-4 mx-auto w-[calc(100%-2rem)] md:inset-y-10 md:w-[min(46rem,calc(100%-5rem))]",
          // On a narrow viewport the docked card takes the width it can get
          // rather than the width the user last chose on a desktop.
          !isExpanded && isMobile && "w-[calc(100vw-1.5rem)]"
        )}
        ref={card}
        role={isExpanded ? "dialog" : "region"}
        style={measured}
      >
        {!(isExpanded || isMobile) && (
          <ResizeGrip onResize={onResize} onResizeEnd={onResizeEnd} />
        )}
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-border/60 border-b pr-8 pl-3">
          <h2 className="flex items-center gap-2 font-medium text-sm">
            <SparklesIcon aria-hidden className="size-4" />
            Agent
            {isGenerating && (
              <span
                className="shimmer text-muted-foreground text-xs motion-reduce:animate-none"
                role="status"
              >
                Working
              </span>
            )}
          </h2>
          <span className="flex items-center gap-0.5">
            <Button
              aria-label={
                isExpanded
                  ? "Return the agent panel to the canvas"
                  : "Expand the agent panel over the editor"
              }
              onClick={() => setIsExpanded((expanded) => !expanded)}
              size="icon-sm"
              variant="ghost"
            >
              {isExpanded ? <Minimize2Icon /> : <Maximize2Icon />}
            </Button>
            <Button
              aria-label="Close the agent panel"
              onClick={onClose}
              size="icon-sm"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </span>
        </div>
        <AgentThread />
      </div>
    </>
  );
}

function WorkflowAgentPanel({ workflowId }: { workflowId: string }) {
  const [isOpen, setIsOpen] = useAtom(isAgentPanelOpenAtom);
  const [isExpanded, setIsExpanded] = useAtom(isAgentPanelExpandedAtom);
  const runtime = useAgentRuntime(workflowId);
  const trigger = useRef<HTMLButtonElement>(null);

  // Closing puts the card back on the canvas, so opening the agent again shows
  // the graph beside it rather than a card covering the editor. Focus follows
  // to the button that brings it back, rather than falling to the document.
  const onClose = useCallback(() => {
    setIsExpanded(false);
    setIsOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  }, [setIsExpanded, setIsOpen]);

  return (
    // Cleared to the right of the canvas controls. On a narrow viewport the
    // panel takes the width available inside the canvas.
    //
    // A positioned element with a z-index makes a stacking context, so this is
    // where the expanded card's depth is decided rather than on the card: no
    // z-index inside can lift it past the `z-20` set here. The properties rail
    // is also `z-20` and comes later in the document, so the card would paint
    // under it at an equal depth.
    <div
      className={cn(
        "pointer-events-none absolute bottom-4 left-4 flex flex-col items-start gap-2 md:left-[4.25rem]",
        isExpanded ? "z-30" : "z-20"
      )}
    >
      {/*
        The provider stays mounted whether the card is up or not. Closing the
        panel hides a conversation; it does not end one. The agent's edits are
        already saved to the draft by the time anyone closes it, so throwing the
        record of what it changed away with the card would leave the workflow
        altered and nothing to read about why.
      */}
      <AssistantRuntimeProvider runtime={runtime}>
        {isOpen ? (
          <AgentCard onClose={onClose} />
        ) : (
          <Button
            className="pointer-events-auto shadow-sm"
            onClick={() => setIsOpen(true)}
            ref={trigger}
            size="sm"
            variant="outline"
          >
            <SparklesIcon />
            Agent
          </Button>
        )}
      </AssistantRuntimeProvider>
    </div>
  );
}

export function AgentPanel({ workflowId }: { workflowId: string }) {
  const canUseAgent =
    can(WfGraphOperations.agentChat.id) &&
    can(WfGraphOperations.workflowUpdate.id);

  if (!canUseAgent) {
    return null;
  }

  return <WorkflowAgentPanel key={workflowId} workflowId={workflowId} />;
}
