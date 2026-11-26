/**
 * The build agent on the canvas: a prompt at the bottom of the canvas, and the
 * conversation, which opens as a panel directly above it. At rest the prompt
 * is a one-line pill; focus grows it upward into the full prompt line. The
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
import { focusStepWhenFocusIsLost } from "#src/components/workflow/step-focus-landing";
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
  "Ask about this workflow or describe a change";

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

/** The grow and shrink between the pill and the full line, in the 150 to 250ms band. */
const PROMPT_TRANSITION = "duration-200 ease-out motion-reduce:transition-none";

/**
 * The prompt line: the attached step's chip or the selected step offered as
 * one, the text field, and Send, or Stop while the agent works. `mark` draws a
 * quiet dot, named for what it means, while the agent is working or has
 * replied since the conversation was collapsed. `pill` draws the line at rest:
 * fully rounded, one row, with the chip row closed to no height and out of
 * the tab order.
 */
function PromptLine({
  input,
  pill,
  attached,
  offered,
  mark,
  onAttach,
  onDetach,
  onSend,
  onActivate,
  onOpen,
}: {
  input: RefObject<HTMLTextAreaElement | null>;
  pill: boolean;
  attached: AttachedStep | null;
  offered: AttachedStep | null;
  mark: "working" | "replied" | null;
  onAttach: (step: AttachedStep) => void;
  onDetach: () => void;
  onSend: () => void;
  /** Opens the conversation when the thread holds messages. */
  onActivate: () => void;
  /** Opens the conversation, empty or not. */
  onOpen: () => void;
}) {
  const showsOffer = offered !== null && offered.id !== attached?.id;
  const showsChips = !pill && (attached !== null || showsOffer);
  return (
    <div
      className={cn(
        "flex flex-col border bg-card shadow-sm transition-[border-radius,padding] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring",
        PROMPT_TRANSITION,
        pill ? "rounded-3xl px-1.5 py-1" : "rounded-xl px-2 py-1.5"
      )}
      data-slot="agent-prompt-line"
      data-state={pill ? "pill" : "grown"}
    >
      {/* The chip row opens from no height to its own, so the line grows
          upward from a bottom edge that stays put. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows]",
          PROMPT_TRANSITION,
          showsChips ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
        inert={!showsChips}
      >
        {/* The gap to the text row is this row's own bottom padding, inside
            the box that closes, so the closed row takes no space. */}
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-wrap items-center gap-1 px-1 pb-1">
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
        </div>
      </div>
      <ComposerPrimitive.Root
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        {mark ? (
          // The dot is the one visible sign of a reply, so it is also the
          // control that shows it. The hit area reaches past the 8px dot.
          <button
            aria-label={
              mark === "working"
                ? "The agent is working. Show the conversation"
                : "The agent replied. Show the conversation"
            }
            className="mb-1.5 flex size-6 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-slot="agent-mark"
            onClick={onOpen}
            type="button"
          >
            <span className="size-2 rounded-full bg-primary" />
          </button>
        ) : null}
        <ComposerPrimitive.Input
          aria-label="Message the agent"
          cancelOnEscape={false}
          className={cn(
            "min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground md:text-sm",
            // The pill holds one row: a placeholder longer than the pill is
            // cut at its end where it would otherwise wrap to a second row,
            // which happens only on a canvas too narrow for the 352px pill.
            pill ? "max-h-8 overflow-hidden whitespace-nowrap" : "max-h-32"
          )}
          // Focus and a click may open the conversation (`onActivate` decides),
          // and Enter or Down in an empty line always opens it.
          onClick={onActivate}
          onFocus={onActivate}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            const empty = isBlank(event.currentTarget.value);
            if (event.key === "ArrowDown" && empty) {
              event.preventDefault();
              onOpen();
              return;
            }
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (empty) {
                onOpen();
                return;
              }
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
  const threadEmpty = useAuiState(
    (state) => state.thread.messages.length === 0
  );
  const promptBlank = useAuiState((state) =>
    isBlank(state.thread.composer.text)
  );
  const offered = useOfferedStep();
  const [attached, setAttached] = useState<AttachedStep | null>(null);
  const [unseen, setUnseen] = useState(false);
  // Whether focus is anywhere inside the agent: the line, its chips, its
  // buttons, or the open conversation.
  const [focused, setFocused] = useState(false);
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

  // The palette's Agent command asks for the line with the cursor in it.
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

  // On the canvas the prompt rests as a pill while nothing holds it open: no
  // focus inside the agent, no text, and no open conversation. A phone keeps
  // the full line below its main view.
  const pill = variant === "canvas" && !focused && promptBlank && !open;

  const focusLine = () => {
    input.current?.focus({ preventScroll: true });
  };

  // Escape in an empty line with the conversation closed hands focus to the
  // selected step's outline row or card, or to the page when nothing is
  // selected, and the line returns to the pill.
  const returnFocusToCanvas = () => {
    input.current?.blur();
    if (offered !== null) {
      focusStepWhenFocusIsLost(offered.id);
    }
  };

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
    if (event.key !== "Escape" || event.defaultPrevented) {
      return;
    }
    if (open) {
      event.preventDefault();
      close();
      return;
    }
    if (variant === "canvas" && event.target === input.current && promptBlank) {
      event.preventDefault();
      returnFocusToCanvas();
    }
  };

  const line = (
    <PromptLine
      attached={attached}
      input={input}
      mark={open ? null : running ? "working" : unseen ? "replied" : null}
      offered={offered}
      // The pressed chip leaves the page with its row, so focus goes back to
      // the line, which keeps it grown and lets the person keep typing.
      onAttach={(step) => {
        setAttached(step);
        focusLine();
      }}
      onDetach={() => {
        setAttached(null);
        focusLine();
      }}
      // On the canvas an empty thread has nothing to show, so focus only
      // grows the pill; Enter or Down in the empty line still opens it with
      // its suggestions. A phone opens the conversation on focus either way.
      onActivate={() => {
        if (
          !keepClosedOnFocus.current &&
          (variant === "phone" || !threadEmpty)
        ) {
          setOpen(true);
        }
      }}
      onOpen={() => setOpen(true)}
      onSend={send}
      pill={pill}
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
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node && event.currentTarget.contains(next))) {
          setFocused(false);
        }
      }}
      onFocus={() => setFocused(true)}
      onKeyDown={onKeyDown}
    >
      {conversation}
      <div
        className={cn(
          "pointer-events-auto",
          variant === "canvas"
            ? cn(
                // A third of the canvas at rest, held between 352px and
                // 560px, and the full 560px once grown. The box widens about
                // its centre and keeps its bottom edge.
                "transition-[width]",
                PROMPT_TRANSITION,
                pill
                  ? "w-[min(100%,clamp(22rem,33%,35rem))]"
                  : "w-[min(100%,35rem)]"
              )
            : "w-full p-2"
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
