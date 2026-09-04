/**
 * The chat itself: the message list, the composer, and the agent's working-out.
 *
 * The working-out is assistant-ui's, not ours. `AssistantMessage` below is the
 * composition their chain-of-thought guide ships, over the elements vendored
 * under `elements/` from the `r.assistant-ui.com/base/*` registry. Reasoning
 * uses their step-panel design: one "Thinking" disclosure above the message
 * holding a titled step per passage, open while it streams and folded away
 * after. Tool calls fold under a count beneath it, since which call was made is
 * the question worth reopening when the agent gets something wrong.
 *
 * What this file adds to that is wording. `agentToolLabel` names a call by what
 * it asked for, because the raw tool name is the same string a dozen times in
 * one turn.
 */

import {
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
  useAuiState,
} from "@assistant-ui/react";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  SquareIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { AgentMarkdown } from "#src/components/agent/agent-markdown";
import {
  ReasoningPanel,
  type ReasoningStep,
} from "#src/components/agent/elements/reasoning-panel";
import { ToolFallback } from "#src/components/agent/elements/tool-fallback.aui";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "#src/components/agent/elements/tool-group";
import { Button } from "#src/components/ui/button";
import { useAfterCommit } from "#src/hooks/effects";
import { agentToolLabel } from "#src/lib/agent-tool-labels";

/**
 * Which parts group, and into what.
 *
 * Tool calls only. Reasoning is not here at all: `AgentReasoning` draws it from
 * the message's own parts, above everything else, because the step panel is one
 * list rather than something that interleaves with the calls between passages.
 */
const groupWorkingOut = groupPartByType({
  "tool-call": ["group-tool"],
});

/**
 * Markdown emphasis, as the words inside it.
 *
 * The step panel renders a body as plain text, so a passage keeping its
 * asterisks reads as punctuation. The heading is already lifted out by
 * `toReasoningStep`; this is for the bold a model writes mid-paragraph.
 */
function withoutEmphasis(text: string): string {
  return text
    .replaceAll(/\*\*([^*]+)\*\*/gu, "$1")
    .replaceAll(/(?<!\*)\*([^*\n]+)\*/gu, "$1");
}

/** How much of a headingless passage stands in for its title. */
const UNTITLED_STEP_WORDS = 6;

/** The opening of a passage, for a step the model gave no heading. */
function firstWords(body: string): string {
  const words = body.split(/\s+/u).slice(0, UNTITLED_STEP_WORDS);
  return words.length === 0 ? "Thinking" : `${words.join(" ")}…`;
}

/**
 * One heading and its paragraph, from one passage of reasoning.
 *
 * A reasoning summary arrives as markdown with a bold heading over each
 * passage, which is the shape the panel wants: a title on the rail and the body
 * under it. A passage that arrives without a heading keeps the whole text as
 * its body, under a title saying only that the model is working.
 */
function toReasoningStep(text: string): ReasoningStep {
  const heading = /^\s*\*\*([^*\n]+)\*\*\s*/u.exec(text);
  const title = heading?.[1]?.trim();

  if (!(heading && title)) {
    // The body carries the whole passage, so the first words of it name the
    // step. `ReasoningPanel` keys its list by title, and a shared "Thinking"
    // for every headingless passage made those keys collide.
    const body = withoutEmphasis(text.trim());
    return { title: firstWords(body), body };
  }

  return { title, body: withoutEmphasis(text.slice(heading[0].length).trim()) };
}

/**
 * The model's working-out, as the steps it went through.
 *
 * Open while it streams and closed once it settles, unless the reader has
 * opened or closed it themselves, at which point their choice sticks. The
 * resting label names the state rather than a duration: `useLocalRuntime` and
 * this adapter attach no timing, so a "Thought for Ns" label would have nothing
 * to count.
 */
function AgentReasoning() {
  const parts = useAuiState((state) => state.message.parts);
  // The whole turn, not just the passage in flight: a turn reasons, calls a
  // tool, and reasons again, and a panel that settled to "Thought for 3s" in
  // each gap would be reporting the turn finished three times before it had.
  const streaming = useAuiState(
    (state) => state.message.status?.type === "running"
  );
  const [readerOpen, setReaderOpen] = useState<boolean | null>(null);

  const steps = parts.flatMap((part) =>
    part.type === "reasoning" ? [toReasoningStep(part.text)] : []
  );

  if (steps.length === 0) {
    return null;
  }

  return (
    <ReasoningPanel
      onOpenChange={setReaderOpen}
      open={readerOpen ?? streaming}
      restingLabel="Done thinking"
      steps={steps}
      streaming={streaming}
      visibleSteps={steps.length}
    />
  );
}

/**
 * The text of one part.
 *
 * A part primitive reads the part it is inside, so it only works below
 * `MessagePrimitive.Parts`. Rendered anywhere else it throws "The current scope
 * does not have a part property", which is why this is its own component rather
 * than the one line it looks like it should be.
 */
function PartText() {
  return <MessagePartPrimitive.Text />;
}

/** What the panel says before anyone has typed anything. */
function EmptyThread() {
  return (
    <AuiIf condition={(state) => state.thread.isEmpty}>
      <div className="flex flex-col gap-2 py-4 text-muted-foreground text-sm">
        <p className="font-medium text-foreground">Build with the agent</p>
        <p>Describe the automation you want.</p>
        <p>
          The agent reads this workflow and the steps this server offers, then
          edits the canvas as it goes.
        </p>
      </div>
    </AuiIf>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root
      aria-label="You"
      className="flex justify-end"
      role="article"
    >
      <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-secondary px-3 py-2 text-secondary-foreground text-sm">
        <MessagePrimitive.Parts>
          {({ part }) => (part.type === "text" ? <PartText /> : null)}
        </MessagePrimitive.Parts>
      </div>
    </MessagePrimitive.Root>
  );
}

/**
 * assistant-ui's tool row, named by what the call asked for.
 *
 * A write tool answers a sentence built from the draft it changed, and that is
 * the row once the call settles. Everything else — a read tool, and any call
 * still in flight — takes `agentToolLabel`, which reads the tool and the
 * arguments the model wrote, because a turn calls `list_actions` five times and
 * the function name alone draws five identical rows.
 */
function AgentToolCall(props: ToolCallMessagePartProps) {
  return (
    <ToolFallback
      {...props}
      toolName={
        typeof props.result === "string"
          ? props.result
          : agentToolLabel({ args: props.args, toolName: props.toolName })
      }
    />
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root
      aria-label="Agent"
      className="flex flex-col gap-1"
      role="article"
    >
      <AgentReasoning />
      <MessagePrimitive.GroupedParts groupBy={groupWorkingOut}>
        {({ part, children }) => {
          switch (part.type) {
            case "group-tool":
              return (
                <ToolGroupRoot variant="ghost">
                  <ToolGroupTrigger
                    active={part.status.type === "running"}
                    count={part.indices.length}
                  />
                  <ToolGroupContent>{children}</ToolGroupContent>
                </ToolGroupRoot>
              );
            case "text":
              return <AgentMarkdown />;
            case "tool-call":
              return part.toolUI ?? <AgentToolCall {...part} />;
            default:
              return null;
          }
        }}
      </MessagePrimitive.GroupedParts>
      <AuiIf condition={(state) => state.message.status?.type === "incomplete"}>
        <ErrorPrimitive.Root className="flex items-start gap-2 py-1 text-destructive text-xs">
          <AlertCircleIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          <ErrorPrimitive.Message className="min-w-0 break-words" />
        </ErrorPrimitive.Root>
      </AuiIf>
    </MessagePrimitive.Root>
  );
}

/**
 * The composer, pinned to the bottom of the card.
 *
 * It sits inside the scroll viewport rather than below it, so it is held to the
 * same reading column the messages are, at whatever width the card is dragged
 * or expanded to. Its footer pins it down and keeps it there once the thread is
 * taller than the card, with the conversation scrolling behind it.
 */
function Composer() {
  return (
    <ComposerPrimitive.Root className="flex items-end gap-2 rounded-md border border-input bg-input/20 px-2 py-1.5 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
      <ComposerPrimitive.Input
        autoFocus
        className="max-h-32 min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground md:text-sm"
        placeholder="Describe a workflow, or ask for a change"
        rows={1}
      />
      <AuiIf condition={(state) => !state.thread.isRunning}>
        <ComposerPrimitive.Send asChild>
          <Button
            aria-label="Send"
            className="mb-1"
            size="icon-sm"
            type="submit"
          >
            <ArrowUpIcon />
          </Button>
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(state) => state.thread.isRunning}>
        <ComposerPrimitive.Cancel asChild>
          <Button
            aria-label="Stop"
            className="mb-1"
            size="icon-sm"
            variant="outline"
          >
            <SquareIcon />
          </Button>
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </ComposerPrimitive.Root>
  );
}

/**
 * Keep what the reader is looking at where it is while the composer grows.
 *
 * The composer sits at the end of the scrolled column, so a second line of
 * input lengthens that column and the pinned composer then covers the message
 * it grew over. Adding the same number of pixels to the scroll position moves
 * the conversation up by exactly what the composer took, which reads as the
 * message staying put.
 *
 * Driven off the composer's text rather than a resize observer: the text is
 * what makes the field grow, and it is already state React commits.
 */
function useComposerGrowthScroll(): {
  viewport: React.RefObject<HTMLDivElement | null>;
  footer: React.RefObject<HTMLDivElement | null>;
} {
  const viewport = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const measured = useRef<number | null>(null);
  const text = useAuiState((state) => state.composer.text);

  useAfterCommit(text, () => {
    const scroller = viewport.current;
    const field = footer.current;
    if (!(scroller && field)) {
      return;
    }

    const height = field.offsetHeight;
    const previous = measured.current;
    measured.current = height;

    // The first measurement has nothing to compare against, a height of zero
    // means the field has not been laid out yet, and an unchanged height means
    // this keystroke did not grow the field. The composer grows on about one
    // keystroke in forty, and a scroll write on the other thirty-nine fires a
    // scroll event that cancels any smooth scroll in flight.
    if (previous === null || height === 0 || height === previous) {
      return;
    }

    scroller.scrollTop += height - previous;
  });

  return { viewport, footer };
}

export function AgentThread() {
  // The refs belong to the hook: it is the only thing that reads either, and
  // the thread just hands each to the element it names.
  const { viewport, footer } = useComposerGrowthScroll();

  return (
    <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
      {/*
        `turnAnchor="top"` puts each new turn at the top of the viewport and
        stops the view chasing the tail, which generates faster than anyone
        reads. It also defaults `autoScroll` to false, so the reader keeps the
        scroll position they chose and the button below takes them down.
      */}
      <ThreadPrimitive.Viewport
        aria-label="Conversation"
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto"
        ref={viewport}
        tabIndex={0}
        turnAnchor="top"
      >
        {/*
          One column, centred and held to a reading width: expanding the panel
          over the editor makes the card wide enough that a line of prose would
          otherwise run past what anyone can track back to the next line.
        */}
        <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pt-4">
          {/* The clearance the scroll-to-bottom button needs above the pinned
              composer: it floats 44px over the footer, so anything less leaves
              it sitting on the last line of the reply. */}
          <div className="mb-14 flex flex-col gap-4">
            <EmptyThread />
            <ThreadPrimitive.Messages>
              {({ message }) =>
                message.role === "user" ? <UserMessage /> : <AssistantMessage />
              }
            </ThreadPrimitive.Messages>
          </div>
          {/*
            `mt-auto` pins the composer to the bottom of the card, and `sticky`
            keeps it there once the thread is taller than the card, with the
            conversation scrolling behind it. Inside the viewport rather than
            below it so it shares the reading column the messages are held to.
          */}
          <ThreadPrimitive.ViewportFooter
            className="sticky bottom-0 mt-auto flex flex-col gap-2 bg-popover pt-4 pb-4"
            ref={footer}
          >
            <ThreadPrimitive.ScrollToBottom asChild>
              <Button
                aria-label="Scroll to the latest"
                className="-top-11 absolute z-10 self-center rounded-full shadow-sm disabled:invisible"
                size="icon-sm"
                variant="outline"
              >
                <ArrowDownIcon />
              </Button>
            </ThreadPrimitive.ScrollToBottom>
            <Composer />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
