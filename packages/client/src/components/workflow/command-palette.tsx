/**
 * ⌘K: the palette that exposes editor commands and picks a step type.
 *
 * Two stages, held as a page stack in `#src/lib/command-palette`: the root
 * offers workflow and canvas commands plus "Add step", which leads to the
 * node types from the extension catalog. The canvas skips the root and opens
 * on the second page, because someone who right-clicked the graph has already
 * said what they want.
 *
 * Built on Base UI's Autocomplete inside a Dialog, which is the shape their own
 * command-palette example takes. cmdk, which shadcn's `command` is built on,
 * would put four `@radix-ui/*` packages back in the lockfile for one screen.
 */

import { Autocomplete } from "@base-ui/react/autocomplete";
import type { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { BaseUIEvent } from "@base-ui/react/types";
import { partition } from "es-toolkit";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronLeft, Search } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "#src/components/ui/dialog";
import { ActionIcon } from "#src/components/workflow/config/action-grid";
import { useAddStep } from "#src/components/workflow/use-add-step";
import { useAfterCommit, useDomEvent } from "#src/hooks/effects";
import { isTextEntry } from "#src/lib/is-text-entry";
import {
  currentPalettePage,
  paletteCanGoBack,
  popPalettePage,
  pushPalettePage,
  setPaletteQuery,
  type CanvasPosition,
  type CommandPaletteState,
} from "#src/lib/command-palette";
import {
  commandPaletteAtom,
  commandPaletteRefusalAtom,
  openCommandPaletteAtom,
} from "#src/lib/command-palette-store";
import { stepGroups, stepSearchText } from "#src/lib/step-types";
import {
  WorkflowCommandIcon,
  type WorkflowCommand,
} from "#src/lib/workflow-commands";
import { canvasEditingLockedAtom } from "#src/lib/workflow-graph-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { selectableActions } from "@wfgraph/shared/extensions/catalog";
import { cn } from "@wfgraph/shared/utils";

type PaletteItem = {
  readonly id: string;
  readonly label: string;
  /** The rest of the row, when the item has something worth adding. */
  readonly detail?: string;
  /** A shortcut or a keyboard hint, printed at the end of the row. */
  readonly hint?: string;
  /** Everything the item can be found by, which is what the filter matches. */
  readonly keywords: string;
  readonly disabled: boolean;
  /** Whether the row reaches real recipients. The highlight rules below skip these. */
  readonly consequential: boolean;
  readonly icon: ReactNode;
  readonly select: () => void;
};

type PaletteGroup = {
  readonly id: string;
  readonly label: string;
  readonly items: readonly PaletteItem[];
};

/**
 * Module-level so Base UI's filter keeps one identity across renders. It reads
 * the keywords rather than the label, which is how "delay" finds Wait.
 */
function itemKeywords(item: PaletteItem): string {
  return item.keywords;
}

/**
 * Returns the group with its sending rows moved to the end.
 *
 * Base UI highlights the first row a query leaves standing, and Return takes
 * the highlighted row, so plain matches go ahead of rows that send. This
 * applies only while a query narrows the list. At rest the palette keeps its
 * authored order, where the run commands sit together after "Add step".
 */
function plainRowsFirst(group: PaletteGroup): PaletteGroup {
  const [plain, consequential] = partition(
    group.items,
    (item) => !item.consequential
  );
  return consequential.length === 0
    ? group
    : { ...group, items: [...plain, ...consequential] };
}

/**
 * The highlight styles, applied only while Return would take the row.
 *
 * Disabled rows keep pointer events so the pointer does not fall through to the
 * list, which `autoHighlight="always"` would read as leaving and then highlight
 * the first row. Skipping `data-disabled` keeps a disabled row visually inert.
 */
const HIGHLIGHTED_ROW =
  "data-highlighted:not-data-disabled:bg-muted data-highlighted:not-data-disabled:text-foreground";

function countItems(groups: readonly PaletteGroup[]): number {
  return groups.reduce((total, group) => total + group.items.length, 0);
}

/**
 * The highlighted row, and whether an arrow key put the highlight there.
 *
 * Only an arrow key arms a row that sends. Base UI highlights the first row on
 * its own and follows the pointer, and it keeps that highlight when a query
 * narrows the list to rows that all send. An armed row is the only one that
 * shows the highlight and responds to Return.
 *
 * The row is held by id rather than by object, because the pages below are
 * rebuilt on every render and Base UI re-announces the highlight whenever the
 * item it holds changes identity.
 */
type PaletteHighlight = {
  readonly id: string | undefined;
  readonly consequential: boolean;
  readonly armed: boolean;
};

const NO_HIGHLIGHT: PaletteHighlight = {
  id: undefined,
  consequential: false,
  armed: false,
};

function sameHighlight(a: PaletteHighlight, b: PaletteHighlight): boolean {
  return (
    a.id === b.id && a.consequential === b.consequential && a.armed === b.armed
  );
}

/**
 * Computes the highlight state after one of Base UI's highlight events.
 *
 * An arrow key arms the row it lands on. The pointer arms nothing. A reason of
 * "none" means Base UI placed the highlight itself, either on a narrowed list
 * or as a re-announcement after an arrow key, so it keeps whatever arming the
 * row already had and grants none to a row that had none.
 *
 * An unchanged highlight returns the same state object, so a re-announcement
 * does not cause a render.
 */
function nextHighlight(
  current: PaletteHighlight,
  item: PaletteItem | undefined,
  reason: Autocomplete.Root.HighlightEventReason
): PaletteHighlight {
  const next: PaletteHighlight =
    item === undefined
      ? NO_HIGHLIGHT
      : {
          id: item.id,
          consequential: item.consequential,
          armed:
            reason === "keyboard" ||
            (reason === "none" && current.armed && current.id === item.id),
        };
  return sameHighlight(current, next) ? current : next;
}

/**
 * Keeps the search box focused through a pointer press on the Back control,
 * ahead of the element swap that `goBack` then has to repair for the keyboard
 * path that has no mousedown to cancel.
 */
function keepFocusOnInput(event: ReactMouseEvent) {
  event.preventDefault();
}

/** One identity for the page that has none, so the memo below can return it. */
const NO_GROUPS: readonly PaletteGroup[] = [];

/** The toast id, so holding the chord down replaces the notice rather than stacking it. */
const REFUSAL_TOAST_ID = "command-palette-refused";

/** The toast id for a Return the palette refused, held down or repeated. */
const UNARMED_TOAST_ID = "command-palette-unarmed";

type CommandPaletteProps = {
  commands: readonly WorkflowCommand[];
};

/**
 * The palette and the key that opens it.
 *
 * The listener lives on this component rather than on the dialog inside it,
 * because the dialog is mounted only while the palette is up and a shortcut
 * that only works once the thing is open is not a shortcut. Rendered by
 * `ToolbarActions`, which renders nothing at all for a non-owner.
 */
export function CommandPalette({ commands }: CommandPaletteProps) {
  const palette = useAtomValue(commandPaletteAtom);
  const setPalette = useSetAtom(commandPaletteAtom);
  const openPalette = useSetAtom(openCommandPaletteAtom);
  const refusal = useAtomValue(commandPaletteRefusalAtom);
  const workflowId = useAtomValue(currentWorkflowIdAtom);

  // Opening another workflow throws the palette away rather than leaving it
  // held: `commandPaletteAtom` already refuses to show one belonging to a
  // workflow that is no longer open, and this is what stops that held state
  // springing back the moment the browser's Back button returns to it.
  useAfterCommit(workflowId, () => setPalette(null));

  // Capture phase for the same reason Cmd+S takes it one level up: a focused
  // field on the canvas would otherwise see the chord first. A text field the
  // user is typing in keeps it, which is the rule Cmd+Enter follows -- except
  // while the palette is up, where the field holding focus is the palette's own
  // and the chord toggles it shut.
  //
  // Shift and Alt are excluded rather than ignored: ⌘⇧K and ⌘⌥K are other
  // people's chords, and swallowing them here would take a browser or OS
  // binding away with nothing offered back.
  const handleShortcut = useCallback(
    (event: KeyboardEvent) => {
      const chord =
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "k";
      if (!chord) {
        return;
      }
      if (palette) {
        event.preventDefault();
        event.stopPropagation();
        setPalette(null);
        return;
      }
      if (isTextEntry(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // A refusal is said out loud. The trigger that would explain it is hidden
      // on a narrow canvas, so a keystroke that did nothing at all would be the
      // whole of the answer.
      if (!openPalette({ id: "root" }) && refusal) {
        toast.info(refusal, { id: REFUSAL_TOAST_ID });
      }
    },
    [palette, setPalette, openPalette, refusal]
  );

  useDomEvent(document, "keydown", handleShortcut, { capture: true });

  if (!palette) {
    return null;
  }

  return <CommandPaletteDialog commands={commands} palette={palette} />;
}

function CommandPaletteDialog({
  palette,
  commands,
}: CommandPaletteProps & { palette: CommandPaletteState }) {
  const setPalette = useSetAtom(commandPaletteAtom);
  const inputRef = useRef<HTMLInputElement>(null);
  const catalog = useExtensionCatalog();
  const editingLocked = useAtomValue(canvasEditingLockedAtom);
  const addStep = useAddStep();
  const hintsId = useId();
  const pageId = useId();

  const page = currentPalettePage(palette);
  const canGoBack = paletteCanGoBack(palette);

  /**
   * The highlight, which the list paints from and Return reads. One fact, so
   * the row wearing the highlight is always the row Return will take.
   */
  const [highlight, setHighlight] = useState<PaletteHighlight>(NO_HIGHLIGHT);

  const close = useCallback(() => setPalette(null), [setPalette]);

  /**
   * Back a page, with focus put back where the typing goes.
   *
   * The header swaps a `<button>` for an `<svg>` when the last page pops, so the
   * element the pointer or the keyboard just acted on unmounts under it. Focus
   * would land on `<body>`, the dialog's trap would pull it to the popup, and
   * the palette would sit there ignoring everything typed into it.
   */
  const goBack = useCallback(() => {
    setPalette(popPalettePage(palette));
    inputRef.current?.focus();
  }, [setPalette, palette]);

  const onStepPage = page.id === "add-step";
  // Held apart from `page` so the memo below depends on the position itself
  // rather than on the state object a keystroke replaces.
  const stepAt: CanvasPosition | undefined =
    page.id === "add-step" ? page.at : undefined;
  /**
   * The node types, which is the one page worth memoising: it walks the whole
   * catalog, and every value it closes over holds its identity across a
   * keystroke. The root page below is six items built from handlers this
   * component is handed fresh on every render, so a memo there would be a
   * dependency list that never matched -- a cost with nothing bought.
   */
  const stepPageGroups = useMemo((): readonly PaletteGroup[] => {
    if (!onStepPage) {
      return NO_GROUPS;
    }
    return stepGroups(selectableActions(catalog)).map((group) => ({
      id: group.category,
      label: group.category,
      items: group.actions.map((action) => ({
        id: action.id,
        label: action.label,
        detail: action.description,
        keywords: stepSearchText(action),
        // The same lock "Add step" carries in the Actions menu. The canvas's
        // context menu opens this page directly, which is the one way in that
        // does not pass that item.
        disabled: editingLocked,
        // Adding a step edits the canvas and sends nothing outward.
        consequential: false,
        icon: <ActionIcon action={action} className="size-3.5" />,
        select: () => {
          addStep({ actionType: action.id, at: stepAt });
          setPalette(null);
        },
      })),
    }));
  }, [onStepPage, stepAt, catalog, editingLocked, addStep, setPalette]);

  const rootPageGroups: readonly PaletteGroup[] = [
    { id: "steps", label: "Steps" },
    { id: "workflow", label: "Workflow" },
    { id: "canvas", label: "Canvas" },
  ].map((group) => ({
    ...group,
    items: commands
      .filter((command) => command.group === group.id)
      .map((command) => ({
        id: command.id,
        label: command.label,
        detail: command.detail,
        hint: command.id === "add-step" ? "→" : command.hint,
        keywords: command.keywords,
        disabled: command.disabled,
        consequential: command.consequential === true,
        icon: (
          <WorkflowCommandIcon
            className="size-3.5 text-muted-foreground"
            id={command.id}
          />
        ),
        select: () => {
          if (command.id === "add-step") {
            setPalette(pushPalettePage(palette, { id: "add-step" }));
            return;
          }
          close();
          command.execute();
        },
      })),
  }));

  let authoredGroups: readonly PaletteGroup[];
  if (onStepPage) {
    authoredGroups = stepPageGroups;
  } else {
    authoredGroups = rootPageGroups;
  }

  const groups =
    palette.query === "" ? authoredGroups : authoredGroups.map(plainRowsFirst);

  // An empty list is two different facts, and the reader is owed the right one:
  // a query that matched nothing, or a surface with no node types in it at all.
  const hasAnyItem = countItems(groups) > 0;

  /**
   * What a screen reader is told the palette is showing. It changes when the
   * page does, which is the only signal of a move that reaches someone who
   * cannot see the placeholder and the option list swap.
   */
  const pageAnnouncement =
    page.id === "add-step"
      ? "Add step. Choose what the new step does."
      : "Commands.";

  /**
   * Escape is contested: the dialog closes on it, and the palette wants it to
   * go back a page first. Cancelling refuses Base UI's own close, which leaves
   * Escape at the root doing the one thing it should.
   */
  const handleOpenChange = (
    open: boolean,
    details: DialogPrimitive.Root.ChangeEventDetails
  ) => {
    if (open) {
      return;
    }
    if (details.reason === "escape-key" && canGoBack) {
      details.cancel();
      goBack();
      return;
    }
    close();
  };

  const handleInputKeyDown = (
    // Base UI passes a merged handler the event with its own opt-out, which is
    // how the Return handler below takes the key from Base UI's list navigation.
    event: BaseUIEvent<ReactKeyboardEvent<HTMLInputElement>>
  ) => {
    // Backspace on an empty box is the other way back, and it must not also
    // delete a character that is not there.
    if (event.key === "Backspace" && palette.query === "" && canGoBack) {
      event.preventDefault();
      goBack();
      return;
    }

    // Return takes the armed row only. Base UI highlights row zero and follows
    // the pointer, so without this check a query narrowed to "Run v5 · Live",
    // or a pointer resting on it, would start that run on a keystroke aimed at
    // the search box.
    if (event.key === "Enter" && highlight.consequential && !highlight.armed) {
      event.preventDefault();
      event.preventBaseUIHandler();
      // Announce the refusal. A keystroke that does nothing explains nothing,
      // and a screen reader never receives the missing highlight.
      toast.info(
        "Use the arrow keys to choose a command that reaches real recipients.",
        { id: UNARMED_TOAST_ID }
      );
    }
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent
        className="top-[12vh] max-w-[min(36rem,calc(100%-2rem))] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[min(36rem,calc(100%-2rem))]"
        // The search box, not the dialog: Base UI parks focus on the popup
        // itself by default, which leaves ⌘K opening a palette that ignores the
        // next thing typed into it.
        initialFocus={inputRef}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        {/* The way out for a touch screen reader, which has no Escape key and
            cannot reach the backdrop. Base UI asks for one inside every modal
            popup, and the palette's own close control is the keyboard. */}
        <DialogClose className="sr-only">Close command palette</DialogClose>
        <p className="sr-only" id={hintsId}>
          Type to search. Press Enter to choose the highlighted item. Press
          Escape, or Backspace on an empty box, to go back a page or close.
        </p>
        {/* Announced when the page changes, which is the only sign of the move
            that reaches a reader who cannot see the list swap. */}
        <p aria-live="polite" className="sr-only" id={pageId}>
          {pageAnnouncement}
        </p>
        <Autocomplete.Root
          autoHighlight="always"
          inline
          items={groups}
          itemToStringValue={itemKeywords}
          onItemHighlighted={(item, details) => {
            // One rule for every event, so a pointer highlight disarms what an
            // arrow key armed. Otherwise the painted row and the row Return
            // takes could differ.
            setHighlight((current) =>
              nextHighlight(current, item, details.reason)
            );
          }}
          onValueChange={(next, details) => {
            // Pressing an item makes Base UI offer the item's own text as the
            // next input value. The query belongs to the page, and the page has
            // just changed or the palette has just closed, so that offer is
            // dropped rather than written back over a box that was cleared.
            //
            // Unreachable as this is written, and deliberately kept: the offer
            // is made only when a `Autocomplete.Popup` has registered itself,
            // which `inline` never renders. Rendering one, or Base UI setting
            // that ref under `inline`, would otherwise refill the box with the
            // chosen item's keyword string with nothing to catch it.
            if (details.reason === "item-press") {
              return;
            }
            // The list has changed, so the row the arrow keys armed no longer
            // holds the highlight. Base UI highlights the narrowed list a
            // moment later, and that highlight arms nothing.
            setHighlight(NO_HIGHLIGHT);
            setPalette(setPaletteQuery(palette, next));
          }}
          open
          value={palette.query}
        >
          <Autocomplete.InputGroup className="flex h-11 items-center gap-2 border-b px-3">
            {canGoBack ? (
              <button
                aria-label="Back to commands"
                className="-ml-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={goBack}
                onMouseDown={keepFocusOnInput}
                type="button"
              >
                <ChevronLeft className="size-3.5" />
              </button>
            ) : (
              <Search
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            )}
            {page.id === "add-step" && (
              // The page's name is already in the live region and the input's
              // description, so this is the visible half of it and nothing more.
              <span
                aria-hidden="true"
                className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs"
              >
                Add step
              </span>
            )}
            <Autocomplete.Input
              // A name that does not move with the page, so the box is called
              // the same thing wherever the reader is: the placeholder is the
              // weakest source an accessible name can come from, and this one's
              // changes underneath it.
              aria-describedby={`${pageId} ${hintsId}`}
              aria-label="Search commands and step types"
              className="h-full w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onKeyDown={handleInputKeyDown}
              placeholder={
                page.id === "add-step"
                  ? "Search step types"
                  : "Search commands, or add a step"
              }
              ref={inputRef}
            />
          </Autocomplete.InputGroup>

          <Autocomplete.Empty>
            <p className="px-3 py-6 text-center text-muted-foreground text-xs">
              {hasAnyItem
                ? "Nothing matches that."
                : "No step types are available yet."}
            </p>
          </Autocomplete.Empty>

          <Autocomplete.List
            aria-label={page.id === "add-step" ? "Step types" : "Commands"}
            className="max-h-[min(24rem,50vh)] overflow-y-auto overscroll-contain p-1"
          >
            {(group: PaletteGroup) => (
              <Autocomplete.Group items={group.items} key={group.id}>
                <Autocomplete.GroupLabel className="px-2 pt-2 pb-1 font-medium text-[0.625rem] text-muted-foreground uppercase tracking-wider">
                  {group.label}
                </Autocomplete.GroupLabel>
                <Autocomplete.Collection>
                  {(item: PaletteItem) => (
                    <Autocomplete.Item
                      className={cn(
                        "flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs/relaxed outline-none select-none",
                        // A row that sends shows the highlight only after an
                        // arrow key arms it, so an automatically highlighted or
                        // hovered row never looks like the row Return takes.
                        (!item.consequential ||
                          (highlight.armed && highlight.id === item.id)) &&
                          HIGHLIGHTED_ROW,
                        "data-disabled:opacity-50"
                      )}
                      disabled={item.disabled}
                      key={item.id}
                      onClick={item.disabled ? undefined : item.select}
                      value={item}
                    >
                      {item.icon}
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium">{item.label}</span>
                        {item.detail && (
                          <span className="text-muted-foreground">
                            {" "}
                            — {item.detail}
                          </span>
                        )}
                      </span>
                      {item.hint && (
                        <span className="shrink-0 text-[0.625rem] text-muted-foreground tracking-widest">
                          {item.hint}
                        </span>
                      )}
                    </Autocomplete.Item>
                  )}
                </Autocomplete.Collection>
              </Autocomplete.Group>
            )}
          </Autocomplete.List>

          {/* The same two facts the input's description carries, for the reader
              who has them on screen. */}
          <div
            aria-hidden="true"
            className="flex items-center justify-end gap-3 border-t px-3 py-1.5 text-[0.625rem] text-muted-foreground"
          >
            <span>↵ to choose</span>
            <span>esc to {canGoBack ? "go back" : "close"}</span>
          </div>
        </Autocomplete.Root>
      </DialogContent>
    </Dialog>
  );
}
