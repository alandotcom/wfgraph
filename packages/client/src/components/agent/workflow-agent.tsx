/**
 * The build agent on the canvas: a prompt at the bottom of the canvas, and the
 * conversation, which opens as a panel directly above it. At rest the prompt
 * is a one-line pill; focus grows it upward into the full prompt line. The
 * agent works on the whole workflow, so it sits with the workflow rather than
 * in the Inspector, which is about one step. A step the person selected
 * is offered as a chip they may attach to the message; nothing is attached
 * unless they attach it.
 *
 * On the canvas the person can hide the whole box with the control on the
 * line's top edge, Cmd+J (Ctrl+J) or the palette, leaving a small Show agent
 * control at the foot of the canvas that carries the same working or replied
 * dot the line does. A reply does not bring the box back by itself.
 *
 * The runtime stays mounted while the conversation is closed, while the box is
 * hidden and while the review sheet hides the line, so a turn in progress
 * keeps going. The thread is kept in this browser per workflow until "New
 * conversation" clears it.
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
  ChevronDown,
  Plus,
  Sparkles,
  SquareIcon,
  SquarePenIcon,
  X,
} from "lucide-react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { type KeyboardEvent, type RefObject, useRef, useState } from "react";
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
import { ControlTooltip } from "#src/components/ui/control-tooltip";
import { useAfterCommit, useAfterPaint, useDomEvent } from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import { canUseBuildAgent } from "#src/lib/authorization";
import {
  editorChordAllowed,
  isAgentToggleChord,
} from "#src/lib/editor-shortcuts";
import { isAgentEnabled } from "#src/lib/extensions";
import {
  currentPlatform,
  editorShortcutLabels,
  isApplePlatform,
} from "#src/lib/shortcut-label";
import { isReviewSheetShownAtom } from "#src/lib/workflow-review-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  agentComposerFocusRequestAtom,
  agentConversationOpenAtom,
  agentHiddenAtom,
  isGeneratingAtom,
  toggleAgentHiddenAtom,
} from "#src/lib/workflow-ui-store";

type AgentRuntime = ReturnType<typeof useAgentRuntime>;

/** The words in the composer before anything is typed. */
export const AGENT_COMPOSER_PLACEHOLDER =
  "Ask about this workflow or describe a change";

/**
 * Where the agent shows: `canvas` from `md` up, `phone` below it.
 * `VARIANT_LAYOUTS` holds what each one changes.
 */
export type WorkflowAgentVariant = "canvas" | "phone";

/** The grow and shrink between the pill and the full line, in the 150 to 250ms band. */
const PROMPT_TRANSITION = "duration-200 ease-out motion-reduce:transition-none";

/** What the agent is doing that the person has not seen, if anything. */
type AgentMark = "working" | "replied" | null;

/** The rules and the layout one variant of the agent follows. */
interface VariantLayout {
  /**
   * Whether the person can hide the whole box, leaving the Show agent control.
   * A phone's line sits in the page's flow below the main view, where hiding
   * it would free no canvas.
   */
  hideable: boolean;
  /**
   * Whether the prompt rests as a one-line pill while nothing holds it open:
   * no focus inside the agent, no text, and no open conversation.
   */
  restsAsPill: boolean;
  /**
   * Whether focusing or clicking the line opens a conversation whose thread
   * holds no messages. Enter or Down in an empty line opens it in every
   * variant, and focus opens a thread that holds messages in every variant.
   */
  focusOpensEmptyThread: boolean;
  /**
   * Whether Escape in an empty line, with the conversation closed, hands focus
   * to the selected step's outline row or card, or to the page when nothing is
   * selected.
   */
  escapeReturnsToCanvas: boolean;
  /** The header control that collapses the conversation back to the line. */
  closeControl: "close" | "back";
  /** Classes on the agent's outer box, given whether the conversation is open. */
  surfaceClass: (open: boolean) => string;
  /** Classes on the open conversation's panel. */
  conversationClass: string;
  /** Classes on the box around the prompt line, given whether it is the pill. */
  composerClass: (pill: boolean) => string;
}

const VARIANT_LAYOUTS: Record<WorkflowAgentVariant, VariantLayout> = {
  // The line and the conversation float over the bottom centre of the canvas,
  // and an empty thread has nothing to show, so focus only grows the pill.
  canvas: {
    hideable: true,
    restsAsPill: true,
    focusOpensEmptyThread: false,
    escapeReturnsToCanvas: true,
    closeControl: "close",
    // The 20px gap above the line holds the Hide agent control's target,
    // which reaches 19px above the line, clear of the conversation.
    surfaceClass: () => "h-full items-center justify-end gap-5",
    conversationClass:
      "h-[60%] w-full max-w-[35rem] rounded-xl shadow-lg ring-1 ring-foreground/10",
    // A third of the canvas at rest, held between 352px and 560px, and the
    // full 560px once grown. The box widens about its centre and keeps its
    // bottom edge.
    composerClass: (pill) =>
      cn(
        "transition-[width]",
        PROMPT_TRANSITION,
        pill ? "w-[min(100%,clamp(22rem,33%,35rem))]" : "w-[min(100%,35rem)]"
      ),
  },
  // The line sits at full height below the main view in the page's flow, and
  // the open conversation covers the whole screen under a Back control.
  phone: {
    hideable: false,
    restsAsPill: false,
    focusOpensEmptyThread: true,
    escapeReturnsToCanvas: false,
    closeControl: "back",
    surfaceClass: (open) =>
      open
        ? "fixed inset-0 z-40 bg-sidebar pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
        : "",
    conversationClass: "flex-1",
    composerClass: () => "w-full p-2",
  },
};

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
 * conversation, and the control that collapses it back to the line: Back at
 * the start, or Close conversation at the end.
 */
function ConversationHeader({
  closeControl,
  onClose,
  onNewConversation,
}: {
  closeControl: VariantLayout["closeControl"];
  onClose: () => void;
  onNewConversation: () => void;
}) {
  const isGenerating = useAtomValue(isGeneratingAtom);
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
      {closeControl === "back" ? (
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
      {closeControl === "close" ? (
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
  mark: AgentMark;
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

/** The agent chord for this keyboard: its keycap and its `aria-keyshortcuts`. */
function agentChord(): { label: string; aria: string } {
  const onApple = isApplePlatform(currentPlatform());
  return {
    label: editorShortcutLabels(onApple).agent,
    aria: onApple ? "Meta+J" : "Control+J",
  };
}

/**
 * The 20px round control on the prompt line's top edge, near its right end,
 * that hides the box. It shows while the pointer is over the line or focus is
 * inside it. Tab reaches it after Send, and focusing it shows it too. The
 * button is a 24px square reaching up from 5px below the line's top edge,
 * where the message field and Send begin, so its target overlaps neither; the
 * circle sits at its foot and straddles the edge.
 */
function HideAgentControl({ onHide }: { onHide: () => void }) {
  const chord = agentChord();
  return (
    <ControlTooltip label="Hide agent" shortcut={chord.label} side="top">
      <button
        aria-keyshortcuts={chord.aria}
        aria-label="Hide agent"
        className="group/hide pointer-events-none absolute -top-[19px] right-3 flex size-6 items-end justify-center text-muted-foreground opacity-0 outline-none transition-opacity duration-150 ease-out hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-focus-within/composer:pointer-events-auto group-focus-within/composer:opacity-100 group-hover/composer:pointer-events-auto group-hover/composer:opacity-100 motion-reduce:transition-none"
        data-slot="agent-hide"
        onClick={onHide}
        type="button"
      >
        <span className="flex size-5 items-center justify-center rounded-full border bg-card shadow-sm group-focus-visible/hide:ring-2 group-focus-visible/hide:ring-ring">
          <ChevronDown className="size-3" />
        </span>
      </button>
    </ControlTooltip>
  );
}

/**
 * What stays at the foot of the canvas while the box is hidden: one quiet
 * round button that shows it again. A dot on its corner says the agent is
 * working or has replied since the box was hidden. `buttonRef` receives the
 * button as it mounts, which is how focus lands here when the box hid with
 * focus inside it.
 */
function ShowAgentControl({
  mark,
  onShow,
  buttonRef,
}: {
  mark: AgentMark;
  onShow: () => void;
  buttonRef: (element: HTMLButtonElement | null) => void;
}) {
  const chord = agentChord();
  const label =
    mark === "working"
      ? "Show agent. The agent is working"
      : mark === "replied"
        ? "Show agent. The agent replied"
        : "Show agent";
  return (
    <ControlTooltip label={label} shortcut={chord.label} side="top">
      <Button
        aria-keyshortcuts={chord.aria}
        aria-label={label}
        className="relative rounded-full bg-card text-muted-foreground shadow-sm hover:text-foreground"
        onClick={onShow}
        ref={buttonRef}
        size="icon-lg"
        type="button"
        variant="outline"
      >
        <Sparkles />
        {mark ? (
          <span
            className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-primary ring-2 ring-card"
            data-slot="agent-mark"
          />
        ) : null}
      </Button>
    </ControlTooltip>
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
  const hiddenPreference = useAtomValue(agentHiddenAtom);
  const toggleHidden = useSetAtom(toggleAgentHiddenAtom);
  const running = useAuiState((state) => state.thread.isRunning);
  const threadEmpty = useAuiState(
    (state) => state.thread.messages.length === 0
  );
  const promptBlank = useAuiState((state) =>
    isBlank(state.thread.composer.text)
  );
  const layout = VARIANT_LAYOUTS[variant];
  const hidden = layout.hideable && hiddenPreference;
  const offered = useOfferedStep();
  const [attached, setAttached] = useState<AttachedStep | null>(null);
  const [unseen, setUnseen] = useState(false);
  // Whether focus is anywhere inside the agent: the line, its chips, its
  // buttons, or the open conversation.
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  // Set when the box hides with focus inside it, and cleared by the Show
  // agent control as it takes that focus.
  const focusShowControl = useRef(false);
  const wasRunning = useRef(running);
  const wasOpenRef = useRef(open);
  // True only inside `focusLineKeepingClosed`. The browser runs the line's
  // focus handler synchronously inside `focus()`, so the handler reads it.
  const keepClosedOnFocus = useRef(false);

  // Moves focus to the line as the conversation collapses, without the line's
  // focus handler opening the conversation again.
  const focusLineKeepingClosed = () => {
    keepClosedOnFocus.current = true;
    input.current?.focus({ preventScroll: true });
    keepClosedOnFocus.current = false;
  };

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
      focusLineKeepingClosed();
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

  const close = () => {
    setOpen(false);
    focusLineKeepingClosed();
  };

  // Hiding collapses the conversation and keeps it. Showing again asks for
  // the cursor in the line, which opens a conversation that holds messages,
  // the way focusing the line always does.
  const toggleBox = () => {
    if (!hidden) {
      focusShowControl.current =
        surface.current?.contains(document.activeElement) ?? false;
    }
    toggleHidden();
  };

  // Show agent takes the focus the box held as it hid, and only that once.
  const takeShowControlFocus = (element: HTMLButtonElement | null) => {
    if (element !== null && focusShowControl.current) {
      focusShowControl.current = false;
      element.focus({ preventScroll: true });
    }
  };

  // Cmd+J or Ctrl+J hides and shows the box from anywhere in the editor,
  // the agent's own field included, but not past an open dialog or menu.
  useDomEvent(
    document,
    "keydown",
    (event) => {
      if (
        !isAgentToggleChord(event) ||
        event.defaultPrevented ||
        !editorChordAllowed(event, { inTextFields: true })
      ) {
        return;
      }
      event.preventDefault();
      toggleBox();
    },
    { enabled: layout.hideable && !reviewShown }
  );

  const pill = layout.restsAsPill && !focused && promptBlank && !open;

  const focusLine = () => {
    input.current?.focus({ preventScroll: true });
  };

  // Escape's hand-off from an empty line: focus goes to the selected step's
  // outline row or card, or to the page when nothing is selected, and the
  // line returns to the pill.
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
    if (
      layout.escapeReturnsToCanvas &&
      event.target === input.current &&
      promptBlank
    ) {
      event.preventDefault();
      returnFocusToCanvas();
    }
  };

  const mark: AgentMark = running ? "working" : unseen ? "replied" : null;

  const line = (
    <PromptLine
      attached={attached}
      input={input}
      mark={open ? null : mark}
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
      onActivate={() => {
        if (
          !keepClosedOnFocus.current &&
          (layout.focusOpensEmptyThread || !threadEmpty)
        ) {
          setOpen(true);
        }
      }}
      onOpen={() => setOpen(true)}
      onSend={send}
      pill={pill}
    />
  );
  const conversation =
    open && !hidden ? (
      <section
        aria-label="Agent conversation"
        className={cn(
          "pointer-events-auto flex min-h-0 flex-col overflow-hidden bg-popover text-popover-foreground",
          layout.conversationClass
        )}
        data-slot="agent-conversation"
      >
        <ConversationHeader
          closeControl={layout.closeControl}
          onClose={close}
          onNewConversation={newConversation}
        />
        <AgentThread />
      </section>
    ) : null;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        layout.surfaceClass(open),
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
      ref={surface}
    >
      {hidden ? (
        <div className="pointer-events-auto" data-slot="agent-show-control">
          <ShowAgentControl
            mark={mark}
            buttonRef={takeShowControlFocus}
            onShow={toggleBox}
          />
        </div>
      ) : (
        <>
          {conversation}
          <div
            className={cn(
              "group/composer pointer-events-auto relative",
              layout.composerClass(pill)
            )}
            data-slot="agent-composer"
          >
            {line}
            {layout.hideable ? <HideAgentControl onHide={toggleBox} /> : null}
          </div>
        </>
      )}
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
