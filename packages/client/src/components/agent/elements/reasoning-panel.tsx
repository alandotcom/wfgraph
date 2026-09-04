/**
 * assistant-ui's step-panel design for reasoning, vendored from the Base UI
 * registry at `r.assistant-ui.com/base/elements-reasoning-panel.json`.
 *
 * Library source, with these local edits beyond the imports. The active step's
 * dot takes `bg-info` rather than `bg-blue-500`: DESIGN.md routes work in
 * progress through that token, and a raw Tailwind palette class in this editor
 * is a defect by its own rule. Its pulse honours `prefers-reduced-motion`. The
 * trigger and each step title drop the registry's 13.5px and 13px for
 * `text-xs`, a step on this system's fixed type scale. The trigger and body
 * take `text-muted-foreground` in place of `text-foreground/55` and
 * `text-foreground/50`: those alphas were solved against a dark ground and
 * measure 1.9:1 on Paper, where this system's floor is 4.5:1 and Graphite Mid
 * is the value that holds it. The trigger gains the editor's focus ring, which
 * the registry left as a bare `outline-none`. The panel drops `max-w-sm` so it
 * shares the one reading measure the rest of the message is held to.
 */

import { ChevronDownIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#src/components/ui/collapsible";
import { cn } from "@wfgraph/shared/utils";
import {
  collapsePanel,
  mono,
  ShimmerLabel,
  SwapLabel,
} from "#src/components/agent/elements/surfaces";
import { take } from "#src/components/agent/elements/range";

export interface ReasoningStep {
  title: string;
  body: string;
}

export interface ReasoningPanelProps {
  steps: ReasoningStep[];
  visibleSteps: number;
  streaming: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restingLabel: string;
  elapsed?: string;
  className?: string;
}

export function ReasoningPanel({
  steps,
  visibleSteps,
  streaming,
  open,
  onOpenChange,
  restingLabel,
  elapsed,
  className,
}: ReasoningPanelProps) {
  const shown = take(steps, visibleSteps);

  return (
    <Collapsible
      data-slot="reasoning-panel"
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full", className)}
    >
      <CollapsibleTrigger className="group/trigger flex items-center gap-1.5 rounded-sm py-1 text-muted-foreground text-xs outline-none transition-[color,scale] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 active:scale-[0.98]">
        <SwapLabel active={streaming ? 0 : 1} className="text-start">
          <>
            <ShimmerLabel
              active={streaming}
              className="relative inline-block leading-none"
            >
              Thinking
            </ShimmerLabel>
            {elapsed !== undefined && (
              <span className={cn(mono, "text-foreground/30 tabular-nums")}>
                {elapsed}
              </span>
            )}
          </>
          <>{restingLabel}</>
        </SwapLabel>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-60 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-open/trigger:rotate-180 group-data-panel-open/trigger:rotate-180 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        <ol className="flex flex-col gap-4 pt-3 pb-1">
          {shown.map((step, i) => {
            const active = streaming && i === shown.length - 1;
            return (
              <li
                key={step.title}
                className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both flex gap-3 duration-300"
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-[7px] size-[5px] shrink-0 rounded-full transition-colors duration-300",
                    active
                      ? "animate-pulse bg-info motion-reduce:animate-none"
                      : "bg-foreground/20"
                  )}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <p className="font-medium text-foreground text-xs">
                    {step.title}
                  </p>
                  <p className="mt-0.5 break-words text-muted-foreground text-xs leading-relaxed">
                    {step.body}
                  </p>
                </span>
              </li>
            );
          })}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}
