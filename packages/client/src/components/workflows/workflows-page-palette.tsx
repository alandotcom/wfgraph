/**
 * ⌘K on the Workflows page: open a workflow by name, create one, and reach the
 * Settings menu's rows and the shortcut reference.
 *
 * The editor's palette (`components/workflow/command-palette.tsx`) belongs to
 * an open workflow and reads its graph, so this page has a palette of its own
 * on the same Base UI Autocomplete, with the same row layout and the same
 * ranking from `rankPaletteGroups`.
 */

import { Autocomplete } from "@base-ui/react/autocomplete";
import { Plus, Search, Workflow } from "lucide-react";
import { type ReactNode, useCallback, useId, useRef, useState } from "react";
import { Button } from "#src/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "#src/components/ui/dialog";
import { Kbd } from "#src/components/ui/kbd";
import { useSettingsCommands } from "#src/hooks/use-app-commands";
import { useDomEvent } from "#src/hooks/effects";
import { editorChordAllowed } from "#src/lib/editor-shortcuts";
import { rankPaletteGroups } from "#src/lib/palette-search";
import {
  currentPlatform,
  editorShortcutLabels,
  isApplePlatform,
} from "#src/lib/shortcut-label";

type PageRow = {
  readonly id: string;
  readonly label: string;
  readonly detail?: string | undefined;
  readonly hint?: string | undefined;
  readonly keywords: string;
  readonly icon: ReactNode;
  readonly select: () => void;
};

type PageGroup = {
  readonly id: string;
  readonly label: string;
  readonly items: readonly PageRow[];
};

/** Module-level so Base UI keeps one identity across renders. */
function rowKeywords(row: PageRow): string {
  return row.keywords;
}

type WorkflowsPagePaletteProps = {
  workflows: readonly { readonly id: string; readonly name: string }[];
  /** Absent when the person cannot open a workflow. */
  onOpenWorkflow?: ((workflowId: string) => void) | undefined;
  /** Absent when the person cannot create a workflow. */
  onNewWorkflow?: (() => void) | undefined;
};

/** The palette's trigger, the ⌘K chord, and the palette itself. */
export function WorkflowsPagePalette(props: WorkflowsPagePaletteProps) {
  const [open, setOpen] = useState(false);
  const onApple = isApplePlatform(currentPlatform());
  const chord = editorShortcutLabels(onApple).palette;

  // The editor's rule for the chord: it opens from a text field too, toggles
  // the palette shut, and does nothing while another dialog or menu is open.
  useDomEvent(
    document,
    "keydown",
    (event) => {
      const isChord =
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "k";
      if (!isChord) {
        return;
      }
      if (open) {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (!editorChordAllowed(event, { inTextFields: true })) {
        return;
      }
      event.preventDefault();
      setOpen(true);
    },
    { capture: true }
  );

  return (
    <>
      <Button
        aria-keyshortcuts={onApple ? "Meta+K" : "Control+K"}
        className="w-64 justify-start font-normal text-muted-foreground"
        onClick={() => setOpen(true)}
        type="button"
        variant="outline"
      >
        <Search className="size-3.5" data-icon="inline-start" />
        <span className="truncate">Search workflows and commands</span>
        <Kbd aria-hidden="true" className="ml-auto">
          {chord}
        </Kbd>
      </Button>
      {open ? (
        <PagePaletteDialog {...props} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function PagePaletteDialog({
  workflows,
  onOpenWorkflow,
  onNewWorkflow,
  onClose,
}: WorkflowsPagePaletteProps & { onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hintsId = useId();
  const [query, setQuery] = useState("");
  const settingsCommands = useSettingsCommands();

  // Every row closes the palette before it acts, so a dialog the row opens
  // takes focus from a palette that is already gone.
  const choose = useCallback(
    (run: () => void) => () => {
      onClose();
      run();
    },
    [onClose]
  );

  const authored: PageGroup[] = [
    ...(onOpenWorkflow
      ? [
          {
            id: "workflows",
            label: "Workflows",
            items: workflows.map((workflow) => ({
              id: `workflow:${workflow.id}`,
              label: workflow.name,
              keywords: `${workflow.name} workflow open go to`,
              icon: <Workflow className="size-3.5 text-muted-foreground" />,
              select: choose(() => onOpenWorkflow(workflow.id)),
            })),
          },
        ]
      : []),
    ...(onNewWorkflow
      ? [
          {
            id: "actions",
            label: "Actions",
            items: [
              {
                id: "new-workflow",
                label: "New workflow",
                keywords: "New workflow create add",
                icon: <Plus className="size-3.5 text-muted-foreground" />,
                select: choose(onNewWorkflow),
              },
            ],
          },
        ]
      : []),
    {
      id: "settings",
      label: "Settings",
      items: settingsCommands.map((command) => ({
        id: command.id,
        label: command.label,
        detail: command.detail,
        hint: command.hint,
        keywords: command.keywords,
        icon: <command.Icon className="size-3.5 text-muted-foreground" />,
        select: choose(command.execute),
      })),
    },
  ];
  const groups = query === "" ? authored : rankPaletteGroups(authored, query);

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
    >
      <DialogContent
        className="top-[12vh] max-w-[min(36rem,calc(100%-2rem))] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[min(36rem,calc(100%-2rem))]"
        initialFocus={inputRef}
        overlayClassName="bg-transparent"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogClose className="sr-only">Close command palette</DialogClose>
        <p className="sr-only" id={hintsId}>
          Type to search. Press Enter to choose the highlighted item. Press
          Escape to close.
        </p>
        <Autocomplete.Root
          autoHighlight="always"
          filteredItems={groups}
          inline
          items={authored}
          itemToStringValue={rowKeywords}
          onValueChange={(next, details) => {
            if (details.reason !== "item-press") {
              setQuery(next);
            }
          }}
          open
          value={query}
        >
          <Autocomplete.InputGroup className="flex h-11 items-center gap-2 border-b px-3">
            <Search
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <Autocomplete.Input
              aria-describedby={hintsId}
              aria-label="Search workflows and commands"
              className="h-full w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              placeholder="Search workflows and commands"
              ref={inputRef}
            />
          </Autocomplete.InputGroup>
          <Autocomplete.Empty>
            <p className="px-3 py-6 text-center text-muted-foreground text-xs">
              Nothing matches that.
            </p>
          </Autocomplete.Empty>
          <Autocomplete.List
            aria-label="Workflows and commands"
            className="max-h-[min(24rem,50vh)] overflow-y-auto overscroll-contain p-1"
          >
            {(group: PageGroup) => (
              <Autocomplete.Group items={group.items} key={group.id}>
                <Autocomplete.GroupLabel className="px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs">
                  {group.label}
                </Autocomplete.GroupLabel>
                <Autocomplete.Collection>
                  {(row: PageRow) => (
                    <Autocomplete.Item
                      className="flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs/relaxed outline-none select-none data-highlighted:bg-muted data-highlighted:text-foreground"
                      key={row.id}
                      onClick={row.select}
                      value={row}
                    >
                      {row.icon}
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium">{row.label}</span>
                        {row.detail ? (
                          <span className="text-muted-foreground">
                            {" "}
                            — {row.detail}
                          </span>
                        ) : null}
                      </span>
                      {row.hint ? (
                        <Kbd className="ml-auto">{row.hint}</Kbd>
                      ) : null}
                    </Autocomplete.Item>
                  )}
                </Autocomplete.Collection>
              </Autocomplete.Group>
            )}
          </Autocomplete.List>
          <div
            aria-hidden="true"
            className="flex items-center justify-end gap-3 border-t px-3 py-1.5 text-muted-foreground text-xs"
          >
            <span className="inline-flex items-center gap-1">
              <Kbd>↵</Kbd> to choose
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>esc</Kbd> to close
            </span>
          </div>
        </Autocomplete.Root>
      </DialogContent>
    </Dialog>
  );
}
