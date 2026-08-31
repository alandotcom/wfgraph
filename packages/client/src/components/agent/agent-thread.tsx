/**
 * The chat itself: the message list, the composer, and the agent's working-out.
 *
 * assistant-ui ships the primitives unstyled, so every surface here is drawn
 * from the editor's own tokens. Color stays reserved for state, which in a chat
 * means one thing: a tool call that was refused.
 *
 * Reasoning and tool calls are folded into one collapsed "Thinking" disclosure
 * rather than listed inline, because a turn calls a dozen tools and the answer
 * is what the reader came for.
 */

import { Collapsible } from "@base-ui/react/collapsible";
import {
  AuiIf,
  ComposerPrimitive,
  groupPartByType,
  MessagePartPrimitive,
  MessagePrimitive,
  type ReasoningMessagePartProps,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@wfgraph/shared/utils";
import { AgentMarkdown } from "#src/components/agent/agent-markdown";
import { Button } from "#src/components/ui/button";
import { Spinner } from "#src/components/ui/spinner";

/**
 * Which parts belong inside the chain of thought, and how they nest.
 *
 * A path per part type: both reasoning and tool calls sit under one thought
 * group, each under a sub-group of its own kind, so adjacent parts of the same
 * kind coalesce instead of drawing a box each.
 */
const groupThinking = groupPartByType({
  reasoning: ["group-thought", "group-reasoning"],
  "tool-call": ["group-thought", "group-tool"],
});

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
      <div className="flex flex-col gap-2 px-1 py-6 text-muted-foreground text-sm">
        <p className="font-medium text-foreground">Build with the agent</p>
        <p>
          Describe the automation you want. The agent reads this workflow and
          the steps this server offers, then edits the canvas as it goes.
        </p>
      </div>
    </AuiIf>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-secondary px-3 py-2 text-secondary-foreground text-sm">
        <MessagePrimitive.Parts>
          {({ part }) => (part.type === "text" ? <PartText /> : null)}
        </MessagePrimitive.Parts>
      </div>
    </MessagePrimitive.Root>
  );
}

/** The model's own working-out, where the provider exposes it. */
function Reasoning({ text }: ReasoningMessagePartProps) {
  return (
    <p className="whitespace-pre-wrap px-2.5 py-1.5 text-muted-foreground text-xs italic">
      {text}
    </p>
  );
}

/**
 * One tool call, as a line a person reads.
 *
 * The arguments stay out of it: what the agent did is the summary the tool
 * answered, and the canvas beside the panel is where the result actually shows.
 */
function ToolCall({
  toolName,
  result,
  isError,
  status,
}: ToolCallMessagePartProps) {
  const running = status.type === "running";
  const summary = typeof result === "string" ? result : toolName;

  return (
    <div
      className={cn(
        "flex items-start gap-2 px-2.5 py-1.5 text-xs",
        isError ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {running ? (
        <Spinner className="mt-px size-3.5" />
      ) : isError ? (
        <XIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      ) : (
        <CheckIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      )}
      <span className="min-w-0 break-words">
        {running ? toolName : summary}
      </span>
    </div>
  );
}

/**
 * The collapsed chain of thought.
 *
 * Closed by default: a turn calls a dozen tools, and what the reader came for is
 * the answer under it. It stays available because when the agent gets something
 * wrong, which step it was is the whole question.
 */
function ThinkingDisclosure({ children }: { children: React.ReactNode }) {
  return (
    <Collapsible.Root className="rounded-md border">
      <Collapsible.Trigger className="group flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-muted-foreground text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 transition-transform duration-150 group-data-[panel-open]:rotate-90"
        />
        <BrainIcon aria-hidden className="size-3.5 shrink-0" />
        Thinking
      </Collapsible.Trigger>
      <Collapsible.Panel className="border-t">{children}</Collapsible.Panel>
    </Collapsible.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-col gap-2">
      <MessagePrimitive.GroupedParts groupBy={groupThinking}>
        {({ part, children }) => {
          switch (part.type) {
            case "group-thought":
              return <ThinkingDisclosure>{children}</ThinkingDisclosure>;
            // The two inner groups only exist so adjacent parts of one kind
            // coalesce; neither draws a frame of its own.
            case "group-reasoning":
            case "group-tool":
              return <>{children}</>;
            case "text":
              return <AgentMarkdown />;
            case "reasoning":
              return <Reasoning {...part} />;
            case "tool-call":
              return part.toolUI ?? <ToolCall {...part} />;
            default:
              return null;
          }
        }}
      </MessagePrimitive.GroupedParts>
    </MessagePrimitive.Root>
  );
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="flex items-end gap-2 border-t bg-background px-3 py-2.5">
      <ComposerPrimitive.Input
        autoFocus
        className="max-h-32 min-h-9 flex-1 resize-none bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
        placeholder="Describe a workflow, or ask for a change"
        rows={1}
      />
      <AuiIf condition={(state) => !state.thread.isRunning}>
        <ComposerPrimitive.Send asChild>
          <Button aria-label="Send" size="icon-sm" type="submit">
            <ArrowUpIcon />
          </Button>
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(state) => state.thread.isRunning}>
        <ComposerPrimitive.Cancel asChild>
          <Button aria-label="Stop" size="icon-sm" variant="outline">
            <SquareIcon />
          </Button>
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </ComposerPrimitive.Root>
  );
}

export function AgentThread() {
  return (
    <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
      {/*
        `turnAnchor="top"` puts each new turn at the top of the viewport and
        stops the view chasing the tail, which generates faster than anyone
        reads. It also defaults `autoScroll` to false, so the reader keeps the
        scroll position they chose and the button below takes them down.
      */}
      <ThreadPrimitive.Viewport
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3"
        turnAnchor="top"
      >
        <EmptyThread />
        <ThreadPrimitive.Messages>
          {({ message }) =>
            message.role === "user" ? <UserMessage /> : <AssistantMessage />
          }
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>
      <ThreadPrimitive.ScrollToBottom asChild>
        <Button
          aria-label="Scroll to the latest"
          className="-translate-x-1/2 absolute bottom-2 left-1/2 z-10 shadow-sm disabled:invisible"
          size="icon-sm"
          variant="outline"
        >
          <ArrowDownIcon />
        </Button>
      </ThreadPrimitive.ScrollToBottom>
      <Composer />
    </ThreadPrimitive.Root>
  );
}
