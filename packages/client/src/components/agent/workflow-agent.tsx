/**
 * The build agent on the canvas: one prompt line at the bottom of the canvas,
 * and the conversation, which opens as a panel directly above the line. The
 * agent works on the whole workflow, so it sits with the workflow rather than
 * in the details column, which is about one step. A step the person selected
 * is offered as a chip they may attach to the message; nothing is attached
 * unless they attach it.
 *
 * The runtime stays mounted while the conversation is closed and while the
 * review sheet hides the line, so a turn in progress keeps going. The thread is
 * kept in this browser per workflow until "New conversation" clears it.
 *
 * Absent entirely when the host configured no model, or for a person who may
 * not use the agent: a disabled control the user cannot enable is worse than
 * no control.
 */

import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowLeft,
  ArrowUpIcon,
  Plus,
  SquareIcon,
  SquarePenIcon,
  X,
} from "lucide-react";
import { useAtom, useAtomValue } from "jotai";
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from "react";
import { cn } from "@wfgraph/shared/utils";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { isBlank } from "@wfgraph/shared/types/string";
import { AgentThread } from "#src/components/agent/agent-thread";
import { useSelectedStep } from "#src/components/workflow/use-selected-step";
import {
  ATTACHED_STEPS_KEY,
  type AttachedStep,
  attachedStepText,
} from "#src/components/agent/attached-steps";
import { forgetAgentThread } from "#src/components/agent/thread-storage";
import { useAgentRuntime } from "#src/components/agent/use-agent-runtime";
import { Button } from "#src/components/ui/button";
import { useAfterCommit, useAfterPaint } from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import { canUseBuildAgent } from "#src/lib/authorization";
import { isAgentEnabled } from "#src/lib/extensions";
import { isReviewSheetShownAtom } from "#src/lib/workflow-review-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  agentComposerFocusRequestAtom,
  agentConversationOpenAtom,
  isGeneratingAtom,
} from "#src/lib/workflow-ui-store";

type AgentRuntime = ReturnType<typeof useAgentRuntime>;

/** The words in the composer before anything is typed. */
export const AGENT_COMPOSER_PLACEHOLDER =
  "Ask about this workflow, or describe a change";

/**
 * Where the agent shows: `canvas` floats the line and the panel over the
 * canvas; `phone` puts the line below the main view, above the status strip,
 * and opens the conversation over the whole screen.
 */
export type WorkflowAgentVariant = "canvas" | "phone";

/**
 * The one step the selection holds, as the chip that offers it: its number in
 * the outline, when it has one, and its label.
 */
function useOfferedStep(): AttachedStep | null {
  const step = useSelectedStep();
  return step === null
    ? null
    : omitUndefined({
        id: step.node.id,
        label: step.label,
        number: step.number,
      });
}

/**
 * The conversation's header: what it is, whether the agent is working, a new
 * conversation, and the control that collapses it back to the line, which on a
 * phone is Back.
 */
function ConversationHeader({
  variant,
  onClose,
  onNewConversation,
}: {
  variant: WorkflowAgentVariant;
  onClose: () => void;
  onNewConversation: () => void;
}) {
  const isGenerating = useAtomValue(isGeneratingAtom);
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
      {variant === "phone" ? (
        <Button
          aria-label="Back"
          onClick={onClose}
          size="icon"
          type="button"
          variant="ghost"
        >
          <ArrowLeft />
        </Button>
      ) : null}
      <h2 className="pl-1 font-medium text-sm">Agent</h2>
      {isGenerating ? (
        <span
          className="shimmer text-muted-foreground text-xs motion-reduce:animate-none"
          role="status"
        >
          Working
        </span>
      ) : null}
      <span className="flex-1" />
      <Button
        disabled={isGenerating}
        onClick={onNewConversation}
        size="sm"
        type="button"
        variant="ghost"
      >
        <SquarePenIcon />
        New conversation
      </Button>
      {variant === "canvas" ? (
        <Button
          aria-label="Close conversation"
          onClick={onClose}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <X />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The prompt line: the attached step's chip or the selected step offered as
 * one, the text field, and Send, or Stop while the agent works. `mark` draws a
 * quiet dot, named for what it means, while the agent is working or has
 * replied since the conversation was collapsed.
 */
function PromptLine({
  input,
  attached,
  offered,
  mark,
  onAttach,
  onDetach,
  onSend,
  onFocus,
}: {
  input: RefObject<HTMLTextAreaElement | null>;
  attached: AttachedStep | null;
  offered: AttachedStep | null;
  mark: "working" | "replied" | null;
  onAttach: (step: AttachedStep) => void;
  onDetach: () => void;
  onSend: () => void;
  onFocus: () => void;
}) {
  const showsOffer = offered !== null && offered.id !== attached?.id;
  return (
    <div
      className="flex flex-col gap-1 rounded-xl border bg-card px-2 py-1.5 shadow-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring"
      data-slot="agent-prompt-line"
    >
      {attached || showsOffer ? (
        <div className="flex flex-wrap items-center gap-1 px-1">
          {attached ? (
            <span
              className="flex items-center gap-1 rounded-md border bg-muted py-0.5 pr-0.5 pl-1.5 text-xs"
              data-slot="agent-attached-step"
            >
              {attachedStepText(attached)}
              <Button
                aria-label={`Remove ${attachedStepText(attached)}`}
                onClick={onDetach}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <X />
              </Button>
            </span>
          ) : null}
          {showsOffer ? (
            <Button
              aria-label={`Attach ${attachedStepText(offered)}`}
              className="text-muted-foreground"
              onClick={() => onAttach(offered)}
              size="xs"
              type="button"
              variant="ghost"
            >
              <Plus />
              {attachedStepText(offered)}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ComposerPrimitive.Root
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        {mark ? (
          <span
            aria-label={
              mark === "working" ? "The agent is working" : "The agent replied"
            }
            className="mb-3 ml-1 size-2 shrink-0 rounded-full bg-primary"
            data-slot="agent-mark"
            role="img"
          />
        ) : null}
        <ComposerPrimitive.Input
          aria-label="Message the agent"
          cancelOnEscape={false}
          className="max-h-32 min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground md:text-sm"
          onFocus={onFocus}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={AGENT_COMPOSER_PLACEHOLDER}
          ref={input}
          rows={1}
          submitMode="none"
        />
        <AuiIf condition={(state) => !state.thread.isRunning}>
          <Button
            aria-label="Send"
            className="mb-1"
            size="icon-sm"
            type="submit"
          >
            <ArrowUpIcon />
          </Button>
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
    </div>
  );
}

function AgentSurface({
  variant,
  runtime,
  workflowId,
}: {
  variant: WorkflowAgentVariant;
  runtime: AgentRuntime;
  workflowId: string;
}) {
  const [open, setOpen] = useAtom(agentConversationOpenAtom);
  const [focusRequest, setFocusRequest] = useAtom(
    agentComposerFocusRequestAtom
  );
  const reviewShown = useAtomValue(isReviewSheetShownAtom);
  const running = useAuiState((state) => state.thread.isRunning);
  const offered = useOfferedStep();
  const [attached, setAttached] = useState<AttachedStep | null>(null);
  const [unseen, setUnseen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const wasRunning = useRef(running);
  const wasOpenRef = useRef(open);
  // Focus moved to the line by Escape from the conversation must not open the
  // conversation it just closed.
  const keepClosedOnFocus = useRef(false);

  // A reply that finishes while the conversation is collapsed leaves the mark
  // on the line until the conversation is opened.
  useAfterCommit(running, () => {
    if (wasRunning.current && !running && !open) {
      setUnseen(true);
    }
    wasRunning.current = running;
  });
  useAfterCommit(open, () => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (open) {
      setUnseen(false);
      return;
    }
    // The conversation also collapses when the agent's edit lands, and focus
    // inside it would fall to the page: it goes to the line instead.
    if (wasOpen && document.activeElement === document.body) {
      keepClosedOnFocus.current = true;
      input.current?.focus({ preventScroll: true });
      keepClosedOnFocus.current = false;
    }
  });

  // The palette's Agent command and "Describe it to the agent" ask for the
  // line with the cursor in it.
  useAfterPaint(focusRequest?.sequence ?? 0, () => {
    if (focusRequest === null) {
      return;
    }
    setFocusRequest(null);
    if (focusRequest.text !== undefined) {
      runtime.thread.composer.setText(focusRequest.text);
    }
    input.current?.focus({ preventScroll: true });
  });

  const close = useCallback(() => {
    setOpen(false);
    keepClosedOnFocus.current = true;
    input.current?.focus({ preventScroll: true });
    keepClosedOnFocus.current = false;
  }, [setOpen]);

  const send = () => {
    const { text } = runtime.thread.composer.getState();
    if (isBlank(text) || running) {
      return;
    }
    runtime.thread.append(
      omitUndefined({
        role: "user" as const,
        content: [{ type: "text" as const, text }],
        metadata:
          attached === null
            ? undefined
            : { custom: { [ATTACHED_STEPS_KEY]: [attached] } },
      })
    );
    runtime.thread.composer.setText("");
    setAttached(null);
    setOpen(true);
  };

  // The stored copy goes first, so nothing the reset leaves behind can be
  // loaded back into the new thread.
  const newConversation = () => {
    forgetAgentThread(workflowId);
    runtime.thread.reset();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && open && !event.defaultPrevented) {
      event.preventDefault();
      close();
    }
  };

  const line = (
    <PromptLine
      attached={attached}
      input={input}
      mark={open ? null : running ? "working" : unseen ? "replied" : null}
      offered={offered}
      onAttach={setAttached}
      onDetach={() => setAttached(null)}
      onFocus={() => {
        if (!keepClosedOnFocus.current) {
          setOpen(true);
        }
      }}
      onSend={send}
    />
  );
  const conversation = open ? (
    <section
      aria-label="Agent conversation"
      className={cn(
        "pointer-events-auto flex min-h-0 flex-col overflow-hidden bg-popover text-popover-foreground",
        variant === "canvas"
          ? "h-[60%] w-full max-w-[35rem] rounded-xl shadow-lg ring-1 ring-foreground/10"
          : "flex-1"
      )}
      data-slot="agent-conversation"
    >
      <ConversationHeader
        onClose={close}
        onNewConversation={newConversation}
        variant={variant}
      />
      <AgentThread />
    </section>
  ) : null;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        variant === "canvas"
          ? "h-full items-center justify-end gap-2"
          : // On a phone the line sits below the main view in the page's
            // flow, and the open conversation covers the whole screen.
            open
            ? "fixed inset-0 z-40 bg-sidebar pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
            : "",
        // The canvas is read-only under the review sheet, so the agent hides
        // and keeps its conversation.
        reviewShown && "hidden"
      )}
      data-slot="workflow-agent"
      onKeyDown={onKeyDown}
    >
      {conversation}
      <div
        className={cn(
          "pointer-events-auto w-full",
          variant === "canvas" ? "max-w-[35rem]" : "p-2"
        )}
        data-slot="agent-composer"
      >
        {line}
      </div>
    </div>
  );
}

/**
 * The agent for `workflowId`, laid out for `variant`, with no check of whether
 * the server offers an agent: `WorkflowAgent` makes that check.
 */
export function WorkflowAgentView({
  variant,
  workflowId,
}: {
  variant: WorkflowAgentVariant;
  workflowId: string;
}) {
  const runtime = useAgentRuntime(workflowId);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AgentSurface
        runtime={runtime}
        variant={variant}
        workflowId={workflowId}
      />
    </AssistantRuntimeProvider>
  );
}

/**
 * The agent for the open workflow, for a viewer who may use it on a server
 * that offers one. The element it renders fills the box its parent gives it,
 * laid out for the canvas from `md` up and for a phone below it.
 */
export function WorkflowAgent() {
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const variant: WorkflowAgentVariant = useIsMobile() ? "phone" : "canvas";
  if (workflowId === null || !isAgentEnabled() || !canUseBuildAgent()) {
    return null;
  }
  return (
    <WorkflowAgentView
      key={workflowId}
      variant={variant}
      workflowId={workflowId}
    />
  );
}
