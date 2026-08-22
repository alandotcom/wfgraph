/**
 * The build agent's panel: a dismissible card over the canvas and the button
 * that opens it.
 *
 * The user watches the graph change while they talk to the agent, so the panel
 * leaves the canvas at full width and can be resized when it covers too much.
 *
 * Absent entirely when the host configured no model: the runtime says so, and a
 * disabled control the user cannot enable is worse than no control.
 */

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { SparklesIcon, XIcon } from "lucide-react";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useRef, useState } from "react";
import { cn } from "@wfgraph/shared/utils";
import { AgentThread } from "#src/components/agent/agent-thread";
import { useAgentRuntime } from "#src/components/agent/use-agent-runtime";
import { Button } from "#src/components/ui/button";
import { useIsMobile } from "#src/hooks/use-mobile";
import {
  type AgentPanelSize,
  agentPanelSizeAtom,
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
      className="-top-1 -right-1 absolute size-3 cursor-nesw-resize rounded-full focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
    />
  );
}

function AgentCard({ onClose }: { onClose: () => void }) {
  const [size, setSize] = useAtom(agentPanelSizeAtom);
  const [dragged, setDragged] = useState<AgentPanelSize | null>(null);
  const isGenerating = useAtomValue(isGeneratingAtom);
  const isMobile = useIsMobile();

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

  return (
    <div
      aria-label="Build agent"
      className={cn(
        "pointer-events-auto relative flex flex-col overflow-hidden rounded-xl border bg-popover shadow-lg",
        // On a narrow viewport the card takes the width it can get rather than
        // the width the user last chose on a desktop.
        isMobile && "w-[calc(100vw-1.5rem)]"
      )}
      role="dialog"
      style={
        isMobile
          ? { height: Math.min(shown.height, 420) }
          : { width: shown.width, height: shown.height }
      }
    >
      {!isMobile && (
        <ResizeGrip onResize={onResize} onResizeEnd={onResizeEnd} />
      )}
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-3">
        <span className="flex items-center gap-2 font-medium text-sm">
          <SparklesIcon aria-hidden className="size-4" />
          Agent
          {isGenerating && (
            <span className="text-muted-foreground text-xs">working</span>
          )}
        </span>
        <Button
          aria-label="Close the agent panel"
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </header>
      <AgentThread />
    </div>
  );
}

function WorkflowAgentPanel({ workflowId }: { workflowId: string }) {
  const [isOpen, setIsOpen] = useAtom(isAgentPanelOpenAtom);
  const runtime = useAgentRuntime(workflowId);

  return (
    // Cleared to the right of the canvas controls. On a narrow viewport the
    // panel takes the width available inside the canvas.
    <div className="pointer-events-none absolute bottom-4 left-4 z-20 flex flex-col items-start gap-2 md:left-[4.25rem]">
      {isOpen ? (
        <AssistantRuntimeProvider runtime={runtime}>
          <AgentCard onClose={() => setIsOpen(false)} />
        </AssistantRuntimeProvider>
      ) : (
        <Button
          className="pointer-events-auto shadow-sm"
          onClick={() => setIsOpen(true)}
          size="sm"
          variant="outline"
        >
          <SparklesIcon />
          Agent
        </Button>
      )}
    </div>
  );
}

export function AgentPanel({ workflowId }: { workflowId: string }) {
  return <WorkflowAgentPanel key={workflowId} workflowId={workflowId} />;
}
