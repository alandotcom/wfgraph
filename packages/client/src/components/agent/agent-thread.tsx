/**
 * The conversation itself: the message list and the agent's working-out.
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
  ActionBarPrimitive,
  AuiIf,
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
  CheckIcon,
  CopyIcon,
  RotateCcwIcon,
  Undo2Icon,
} from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import { useMemo, useState } from "react";
import { AgentMarkdown } from "#src/components/agent/agent-markdown";
import {
  attachedStepText,
  readAttachedSteps,
} from "#src/components/agent/attached-steps";
import {
  nodeChangeSummary,
  omittedMessagesNotice,
  readTurnMetadata,
  usageSummary,
} from "#src/components/agent/turn-metadata";
import {
  agentTurnUndoStateAtom,
  undoAgentTurnAtom,
} from "#src/components/agent/turn-undo";
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
import {
  agentReasoningLabel,
  agentToolLabel,
} from "#src/lib/agent-tool-labels";

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
 * opened or closed it themselves, at which point their choice sticks.
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
      restingLabel={agentReasoningLabel(parts)}
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

/**
 * Questions the empty panel offers as one-press starts. Each sends at once,
 * since the agent can answer it from the workflow and its runs alone.
 */
const STARTER_PROMPTS = [
  "Explain this workflow",
  "Why did the last run fail?",
] as const;

/** What the panel says before anyone has typed anything. */
function EmptyThread() {
  return (
    <AuiIf condition={(state) => state.thread.isEmpty}>
      <div className="flex flex-col gap-2 py-4 text-muted-foreground text-sm">
        <p className="font-medium text-foreground">
          Ask the agent, or build with it
        </p>
        <p>
          The agent reads this workflow, its runs, and the steps this server
          offers. It answers questions and edits the canvas.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          {STARTER_PROMPTS.map((prompt) => (
            <ThreadPrimitive.Suggestion
              asChild
              key={prompt}
              prompt={prompt}
              send
            >
              <Button size="sm" type="button" variant="outline">
                {prompt}
              </Button>
            </ThreadPrimitive.Suggestion>
          ))}
        </div>
      </div>
    </AuiIf>
  );
}

/** The steps a message was sent with, as the chips it was written beside. */
function AttachedStepChips() {
  const custom = useAuiState((state) => state.message.metadata.custom);
  const steps = readAttachedSteps(custom);
  if (steps.length === 0) {
    return null;
  }
  return (
    <ul
      aria-label="Attached steps"
      className="flex flex-wrap justify-end gap-1"
    >
      {steps.map((step) => (
        <li
          className="rounded-md border bg-card px-1.5 py-0.5 text-muted-foreground text-xs"
          key={step.id}
        >
          {attachedStepText(step)}
        </li>
      ))}
    </ul>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root
      aria-label="You"
      className="flex flex-col items-end gap-1"
      role="article"
    >
      <AttachedStepChips />
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

/**
 * What a finished turn cost, in one muted line under it. A turn the user
 * stopped ends without a usage part and shows none.
 */
function TurnUsage() {
  const custom = useAuiState((state) => state.message.metadata.custom);
  const { usage } = readTurnMetadata(custom);
  if (!usage) {
    return null;
  }
  return (
    <p className="text-muted-foreground text-xs tabular-nums">
      {usageSummary(usage)}
    </p>
  );
}

/**
 * The editor's Undo for one turn. Disabled once other edits sit on top of the
 * turn's, since the editor's Undo would then revert those first.
 */
function UndoTurnButton({ undoKey }: { undoKey: string }) {
  const stateAtom = useMemo(() => agentTurnUndoStateAtom(undoKey), [undoKey]);
  const state = useAtomValue(stateAtom);
  const undoTurn = useSetAtom(undoAgentTurnAtom);

  if (state === "unknown") {
    return null;
  }
  if (state === "undone") {
    return <span className="text-muted-foreground">Undone</span>;
  }
  return (
    <Button
      className="h-6 text-xs"
      disabled={state === "superseded"}
      onClick={() => undoTurn(undoKey)}
      size="xs"
      title={
        state === "superseded"
          ? "Other edits were made after this turn. Use the editor's Undo to step back through them."
          : "Revert every change this turn made to the workflow"
      }
      variant="ghost"
    >
      <Undo2Icon />
      Undo changes
    </Button>
  );
}

/**
 * What a finished turn changed on the canvas, in one line, with the control
 * that reverts it. A turn that edited nothing shows neither.
 */
function TurnChanges() {
  const custom = useAuiState((state) => state.message.metadata.custom);
  const running = useAuiState(
    (state) => state.message.status?.type === "running"
  );
  const { record, undoKey } = readTurnMetadata(custom);
  const nodes = record?.nodes;
  if (running || !nodes) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
      <span>{nodeChangeSummary(nodes)}</span>
      {undoKey === undefined ? null : <UndoTurnButton undoKey={undoKey} />}
    </div>
  );
}

/**
 * Copy for every finished reply, and Retry for the newest one alone. Retry
 * asks again from the message before it on a new branch of the thread; the
 * edits the earlier attempt made stay on the canvas, where its "Undo changes"
 * still reverts them.
 */
function AssistantActions() {
  return (
    <ActionBarPrimitive.Root
      className="-ml-1.5 flex items-center gap-0.5 text-muted-foreground"
      hideWhenRunning
    >
      <ActionBarPrimitive.Copy asChild>
        <Button aria-label="Copy" size="icon-xs" title="Copy" variant="ghost">
          <AuiIf condition={(state) => state.message.isCopied}>
            <CheckIcon className="size-3" />
          </AuiIf>
          <AuiIf condition={(state) => !state.message.isCopied}>
            <CopyIcon className="size-3" />
          </AuiIf>
        </Button>
      </ActionBarPrimitive.Copy>
      <AuiIf condition={(state) => state.message.isLast}>
        <ActionBarPrimitive.Reload asChild>
          <Button
            aria-label="Retry"
            size="icon-xs"
            title="Retry"
            variant="ghost"
          >
            <RotateCcwIcon className="size-3" />
          </Button>
        </ActionBarPrimitive.Reload>
      </AuiIf>
    </ActionBarPrimitive.Root>
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
      <TurnChanges />
      <TurnUsage />
      <AssistantActions />
    </MessagePrimitive.Root>
  );
}

/**
 * Says so once the thread is long enough that its oldest messages no longer
 * reach the model, read off the newest turn's request. Above the composer, so
 * it is seen before the next message is written rather than lost up-thread.
 */
function OmittedMessagesNotice() {
  const custom = useAuiState(
    (state) => state.thread.messages.at(-1)?.metadata.custom
  );
  const omitted = readTurnMetadata(custom).omittedMessages ?? 0;
  if (omitted === 0) {
    return null;
  }
  return (
    <p className="text-muted-foreground text-xs" role="status">
      {omittedMessagesNotice(omitted)}
    </p>
  );
}

/**
 * The conversation: the messages, the empty state's suggestions, and the
 * scroll-to-latest control. The composer is its own prompt line on the canvas,
 * below this panel.
 */
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
        aria-label="Conversation"
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto"
        tabIndex={0}
        turnAnchor="top"
      >
        <div className="flex w-full flex-1 flex-col px-4 pt-4">
          <div className="flex flex-col gap-4">
            <EmptyThread />
            <ThreadPrimitive.Messages>
              {({ message }) =>
                message.role === "user" ? <UserMessage /> : <AssistantMessage />
              }
            </ThreadPrimitive.Messages>
          </div>
          {/* `sticky` keeps the notice and the scroll control at the bottom of
              the panel once the thread is taller than it. */}
          <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto flex flex-col gap-2 bg-popover pt-4 pb-3">
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
            <OmittedMessagesNotice />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
