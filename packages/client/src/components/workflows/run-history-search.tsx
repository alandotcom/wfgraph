import { ListFilter, Search, XIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useId,
  useRef,
  useState,
} from "react";
import {
  buildRunHistoryMenuItems,
  FIELD_STEP,
  runHistoryMenuHeading,
  runHistorySearchPlaceholder,
  type RunHistoryDraft,
  type RunHistoryMenuAction,
  type WorkflowOption,
} from "#src/components/workflows/run-history-search-menu";
import { useDomEvent } from "#src/hooks/effects";
import {
  addRunFilter,
  createRunFilter,
  formatRunFilterValue,
  removeRunFilter,
  RUN_FILTER_FIELD_LABELS,
  RUN_FILTER_OPERATOR_LABELS,
  type RunFilter,
  type RunFilterField,
  type RunFilterOperator,
} from "#src/lib/run-history-filters";
import { cn } from "@wfgraph/shared/utils";

/** Shared so the ghost overlay and the input paint on the same baseline. */
const SEARCH_FIELD_TYPE = "h-5 font-sans text-xs leading-5";

type RunHistorySearchProps = {
  query: string;
  onQueryChange: (query: string) => void;
  filters: readonly RunFilter[];
  onFiltersChange: (filters: RunFilter[]) => void;
  resultCount: number;
  loadedCount: number;
  workflows: readonly WorkflowOption[];
  eventSuggestions: readonly string[];
  entitySuggestions: readonly string[];
};

function MenuIcon({ kind }: { kind: "search" | "list" }) {
  if (kind === "search") {
    return <Search className="size-3.5 text-muted-foreground" />;
  }
  return <ListFilter className="size-3.5 text-muted-foreground" />;
}

function resultLabel(input: { resultCount: number; loadedCount: number }) {
  if (input.resultCount !== input.loadedCount) {
    return `${input.resultCount} of ${input.loadedCount} loaded`;
  }
  return `${input.resultCount} ${input.resultCount === 1 ? "result" : "results"}`;
}

export function RunHistorySearch({
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  resultCount,
  loadedCount,
  workflows,
  eventSuggestions,
  entitySuggestions,
}: RunHistorySearchProps) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState<RunHistoryDraft>(FIELD_STEP);
  const [highlighted, setHighlighted] = useState(0);

  const menuItems = buildRunHistoryMenuItems({
    draft,
    query,
    workflows,
    eventSuggestions,
    entitySuggestions,
  });
  const safeHighlight =
    menuItems.length === 0 ? 0 : Math.min(highlighted, menuItems.length - 1);
  const heading = runHistoryMenuHeading(draft);
  const ghost =
    menuOpen && query !== "" ? (menuItems[safeHighlight]?.ghost ?? "") : "";
  const activeItem = menuItems[safeHighlight];
  const activeDescendant =
    menuOpen && activeItem ? `${listId}-${activeItem.id}` : undefined;

  const resetDraft = () => {
    setDraft(FIELD_STEP);
    setHighlighted(0);
  };

  const commitFilter = (
    field: RunFilterField,
    operator: RunFilterOperator,
    value: string,
    valueLabel?: string
  ) => {
    onFiltersChange(
      addRunFilter(
        filters,
        createRunFilter({ field, operator, value, valueLabel })
      )
    );
    resetDraft();
    onQueryChange("");
    setMenuOpen(true);
  };

  const runAction = (action: RunHistoryMenuAction) => {
    switch (action.type) {
      case "pick-field":
        setDraft({ step: "operator", field: action.field });
        onQueryChange("");
        setHighlighted(0);
        return;
      case "pick-operator":
        setDraft({
          step: "value",
          field: action.field,
          operator: action.operator,
        });
        onQueryChange("");
        setHighlighted(0);
        return;
      case "commit":
        commitFilter(
          action.field,
          action.operator,
          action.value,
          action.valueLabel
        );
        return;
      case "search":
        setMenuOpen(false);
        resetDraft();
        return;
      default: {
        const exhaustive: never = action;
        void exhaustive;
      }
    }
  };

  const closeMenu = () => {
    setMenuOpen(false);
    resetDraft();
  };

  const goBack = () => {
    if (draft.step === "value") {
      setDraft({ step: "operator", field: draft.field });
      onQueryChange("");
      setHighlighted(0);
      return;
    }
    if (draft.step === "operator") {
      resetDraft();
      onQueryChange("");
      return;
    }
    closeMenu();
  };

  useDomEvent(
    document,
    "mousedown",
    (event) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        closeMenu();
      }
    },
    { enabled: menuOpen, deferAttach: true }
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      goBack();
      return;
    }

    if (event.key === "ArrowDown" && menuItems.length > 0) {
      event.preventDefault();
      setMenuOpen(true);
      setHighlighted((current) => (current + 1) % menuItems.length);
      return;
    }

    if (event.key === "ArrowUp" && menuItems.length > 0) {
      event.preventDefault();
      setMenuOpen(true);
      setHighlighted(
        (current) => (current - 1 + menuItems.length) % menuItems.length
      );
      return;
    }

    if (event.key === "Tab") {
      const item = menuItems[safeHighlight];
      if (item?.action.type === "commit") {
        event.preventDefault();
        runAction(item.action);
      }
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const item = menuItems[safeHighlight];
      if (item) {
        runAction(item.action);
        return;
      }
      if (query.trim() !== "" && draft.step === "field") {
        setMenuOpen(false);
      }
      return;
    }

    if (event.key === "Backspace" && query === "") {
      if (draft.step !== "field") {
        event.preventDefault();
        goBack();
        return;
      }
      const last = filters.at(-1);
      if (last) {
        event.preventDefault();
        onFiltersChange(removeRunFilter(filters, last.id));
      }
    }
  };

  const onRemovePill = (event: ReactMouseEvent, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    onFiltersChange(removeRunFilter(filters, id));
    inputRef.current?.focus();
  };

  return (
    <div className="relative z-20" ref={rootRef}>
      <div
        className={cn(
          "flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-input bg-input/20 px-2 py-1 shadow-xs transition-colors",
          "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30"
        )}
        onClick={() => {
          inputRef.current?.focus();
          setMenuOpen(true);
        }}
      >
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        {filters.map((item) => (
          <span
            className="inline-flex h-5 max-w-full items-center gap-1 rounded-sm bg-muted-foreground/10 py-0 pr-0 pl-1.5 text-xs/relaxed"
            key={item.id}
          >
            <span className="truncate text-muted-foreground">
              {RUN_FILTER_FIELD_LABELS[item.field]}:{" "}
              {RUN_FILTER_OPERATOR_LABELS[item.operator]}{" "}
              <span className="font-medium text-foreground">
                {formatRunFilterValue(item)}
              </span>
            </span>
            <button
              aria-label={`Remove ${RUN_FILTER_FIELD_LABELS[item.field]} ${RUN_FILTER_OPERATOR_LABELS[item.operator]} ${formatRunFilterValue(item)}`}
              className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(event) => {
                onRemovePill(event, item.id);
              }}
              type="button"
            >
              <XIcon className="size-3" />
            </button>
          </span>
        ))}
        <div className="relative grid h-5 min-w-16 flex-1 items-center">
          {ghost !== "" ? (
            <span
              aria-hidden
              className={cn(
                "pointer-events-none col-start-1 row-start-1 overflow-hidden",
                SEARCH_FIELD_TYPE
              )}
            >
              <span className="invisible whitespace-pre">{query}</span>
              <span className="whitespace-pre text-muted-foreground">
                {ghost}
              </span>
            </span>
          ) : null}
          <input
            aria-activedescendant={activeDescendant}
            aria-autocomplete="both"
            aria-controls={listId}
            aria-expanded={menuOpen}
            aria-label="Search and filter runs"
            autoCapitalize="off"
            autoCorrect="off"
            className={cn(
              "col-start-1 row-start-1 w-full min-w-0 appearance-none border-0 bg-transparent p-0 outline-none placeholder:text-muted-foreground",
              SEARCH_FIELD_TYPE
            )}
            onChange={(event) => {
              onQueryChange(event.target.value);
              setMenuOpen(true);
              setHighlighted(0);
            }}
            onFocus={() => {
              setMenuOpen(true);
            }}
            onKeyDown={onKeyDown}
            placeholder={runHistorySearchPlaceholder(draft, filters.length)}
            ref={inputRef}
            role="combobox"
            spellCheck={false}
            value={query}
          />
        </div>
        <span className="shrink-0 pr-0.5 text-muted-foreground text-xs/relaxed tabular-nums">
          {resultLabel({ resultCount, loadedCount })}
        </span>
      </div>

      {menuOpen ? (
        <div
          className="absolute z-50 mt-1 w-full origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
          id={listId}
          role="listbox"
        >
          {heading !== null ? (
            <div className="border-b px-2 py-1.5 text-muted-foreground text-xs">
              {heading}
            </div>
          ) : null}
          {menuItems.length === 0 ? (
            <div className="px-2 py-2 text-muted-foreground text-xs/relaxed">
              No matches.
            </div>
          ) : (
            <ul className="max-h-64 overflow-auto p-1">
              {menuItems.map((item, index) => (
                <li
                  aria-selected={index === safeHighlight}
                  className={cn(
                    "flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs/relaxed",
                    index === safeHighlight
                      ? "bg-accent text-accent-foreground"
                      : undefined
                  )}
                  id={`${listId}-${item.id}`}
                  key={item.id}
                  onClick={() => {
                    runAction(item.action);
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onMouseEnter={() => {
                    setHighlighted(index);
                  }}
                  role="option"
                >
                  <MenuIcon kind={item.icon} />
                  <span className="min-w-0 flex-1 truncate">
                    {item.detail ? (
                      <>
                        <span className="text-muted-foreground">
                          {item.detail}{" "}
                        </span>
                        <span className="font-medium">{item.label}</span>
                      </>
                    ) : (
                      item.label
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
