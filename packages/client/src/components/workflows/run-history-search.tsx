import { ListFilter, Search, XIcon } from "lucide-react";
import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  use,
  useId,
  useMemo,
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
  type RunHistoryMenuItem,
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

type RunHistorySearchState = {
  query: string;
  filters: readonly RunFilter[];
  resultCount: number;
  menuOpen: boolean;
  draft: RunHistoryDraft;
  menuItems: readonly RunHistoryMenuItem[];
  highlighted: number;
  ghost: string;
  placeholder: string;
  heading: string | null;
};

type RunHistorySearchActions = {
  setQuery: (query: string) => void;
  openMenu: () => void;
  closeMenu: () => void;
  highlight: (index: number) => void;
  runAction: (action: RunHistoryMenuAction) => void;
  goBack: () => void;
  removeFilter: (id: string) => void;
  onInputKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  bindRoot: (node: HTMLDivElement | null) => void;
  bindInput: (node: HTMLInputElement | null) => void;
  focusInput: () => void;
};

type RunHistorySearchMeta = {
  listId: string;
};

type RunHistorySearchContextValue = {
  state: RunHistorySearchState;
  actions: RunHistorySearchActions;
  meta: RunHistorySearchMeta;
};

const RunHistorySearchContext =
  createContext<RunHistorySearchContextValue | null>(null);

function useRunHistorySearch(): RunHistorySearchContextValue {
  const value = use(RunHistorySearchContext);
  if (!value) {
    throw new Error(
      "RunHistorySearch parts must render inside RunHistorySearch.Provider"
    );
  }
  return value;
}

/** Shared so the ghost overlay and the input paint on the same baseline. */
const SEARCH_FIELD_TYPE = "h-5 font-sans text-xs leading-5";

type RunHistorySearchProviderProps = {
  query: string;
  onQueryChange: (query: string) => void;
  filters: readonly RunFilter[];
  onFiltersChange: (filters: RunFilter[]) => void;
  resultCount: number;
  workflows: readonly WorkflowOption[];
  eventSuggestions: readonly string[];
  entitySuggestions: readonly string[];
  children: ReactNode;
};

function RunHistorySearchProvider({
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  resultCount,
  workflows,
  eventSuggestions,
  entitySuggestions,
  children,
}: RunHistorySearchProviderProps) {
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

  useDomEvent(
    document,
    "mousedown",
    (event) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setMenuOpen(false);
        setDraft(FIELD_STEP);
        setHighlighted(0);
      }
    },
    { enabled: menuOpen, deferAttach: true }
  );

  const ghost =
    menuOpen && query !== "" ? (menuItems[safeHighlight]?.ghost ?? "") : "";
  const placeholder = runHistorySearchPlaceholder(draft, filters.length);
  const heading = runHistoryMenuHeading(draft);

  const contextValue = useMemo((): RunHistorySearchContextValue => {
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

    const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
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

      if (event.key === "Tab" && menuItems[safeHighlight]?.id !== "search") {
        const item = menuItems[safeHighlight];
        if (
          item &&
          (item.ghost ||
            draft.step === "value" ||
            item.id.startsWith("shortcut:"))
        ) {
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

    return {
      state: {
        query,
        filters,
        resultCount,
        menuOpen,
        draft,
        menuItems,
        highlighted: safeHighlight,
        ghost,
        placeholder,
        heading,
      },
      actions: {
        setQuery: (next) => {
          onQueryChange(next);
          setMenuOpen(true);
          setHighlighted(0);
        },
        openMenu: () => {
          setMenuOpen(true);
        },
        closeMenu,
        highlight: setHighlighted,
        runAction,
        goBack,
        removeFilter: (id) => {
          onFiltersChange(removeRunFilter(filters, id));
        },
        onInputKeyDown,
        bindRoot: (node) => {
          rootRef.current = node;
        },
        bindInput: (node) => {
          inputRef.current = node;
        },
        focusInput: () => {
          inputRef.current?.focus();
        },
      },
      meta: { listId },
    };
  }, [
    draft,
    filters,
    ghost,
    heading,
    listId,
    menuItems,
    menuOpen,
    onFiltersChange,
    onQueryChange,
    placeholder,
    query,
    resultCount,
    safeHighlight,
  ]);

  return (
    <RunHistorySearchContext value={contextValue}>
      {children}
    </RunHistorySearchContext>
  );
}

function RunHistorySearchRoot({ children }: { children: ReactNode }) {
  const {
    actions: { bindRoot },
  } = useRunHistorySearch();
  return (
    <div className="relative z-20" ref={bindRoot}>
      {children}
    </div>
  );
}

function RunHistorySearchFrame({ children }: { children: ReactNode }) {
  const {
    actions: { focusInput, openMenu },
  } = useRunHistorySearch();
  return (
    <div
      className={cn(
        "flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-input bg-input/20 px-2 py-1 shadow-xs transition-colors",
        "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30"
      )}
      onClick={() => {
        focusInput();
        openMenu();
      }}
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      {children}
    </div>
  );
}

function RunHistorySearchPills() {
  const {
    state: { filters },
    actions: { focusInput, removeFilter },
  } = useRunHistorySearch();

  const onRemove = (event: ReactMouseEvent, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    removeFilter(id);
    focusInput();
  };

  return (
    <>
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
              onRemove(event, item.id);
            }}
            type="button"
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
    </>
  );
}

function RunHistorySearchInput() {
  const {
    state: { query, menuOpen, menuItems, highlighted, ghost, placeholder },
    actions: { bindInput, setQuery, openMenu, onInputKeyDown },
    meta,
  } = useRunHistorySearch();
  const activeItem = menuItems[highlighted];
  const activeDescendant =
    menuOpen && activeItem ? `${meta.listId}-${activeItem.id}` : undefined;

  return (
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
          <span className="whitespace-pre text-muted-foreground">{ghost}</span>
        </span>
      ) : null}
      <input
        aria-activedescendant={activeDescendant}
        aria-autocomplete="both"
        aria-controls={meta.listId}
        aria-expanded={menuOpen}
        aria-label="Search and filter runs"
        autoCapitalize="off"
        autoCorrect="off"
        className={cn(
          "col-start-1 row-start-1 w-full min-w-0 appearance-none border-0 bg-transparent p-0 outline-none placeholder:text-muted-foreground",
          SEARCH_FIELD_TYPE
        )}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        onFocus={openMenu}
        onKeyDown={onInputKeyDown}
        placeholder={placeholder}
        ref={bindInput}
        role="combobox"
        spellCheck={false}
        value={query}
      />
    </div>
  );
}

function RunHistorySearchResultCount() {
  const {
    state: { resultCount },
  } = useRunHistorySearch();
  return (
    <span className="shrink-0 pr-0.5 text-muted-foreground text-xs/relaxed tabular-nums">
      {resultCount} {resultCount === 1 ? "result" : "results"}
    </span>
  );
}

function MenuIcon({ kind }: { kind: "search" | "list" }) {
  if (kind === "search") {
    return <Search className="size-3.5 text-muted-foreground" />;
  }
  return <ListFilter className="size-3.5 text-muted-foreground" />;
}

function RunHistorySearchMenu() {
  const {
    state: { menuOpen, menuItems, highlighted, heading },
    actions: { highlight, runAction },
    meta,
  } = useRunHistorySearch();

  if (!menuOpen) {
    return null;
  }

  return (
    <div
      className="absolute z-50 mt-1 w-full origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
      id={meta.listId}
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
              aria-selected={index === highlighted}
              className={cn(
                "flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs/relaxed",
                index === highlighted
                  ? "bg-accent text-accent-foreground"
                  : undefined
              )}
              id={`${meta.listId}-${item.id}`}
              key={item.id}
              onClick={() => {
                runAction(item.action);
              }}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onMouseEnter={() => {
                highlight(index);
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
  );
}

type RunHistorySearchProps = Omit<RunHistorySearchProviderProps, "children">;

function RunHistorySearchBar() {
  return (
    <RunHistorySearchRoot>
      <RunHistorySearchFrame>
        <RunHistorySearchPills />
        <RunHistorySearchInput />
        <RunHistorySearchResultCount />
      </RunHistorySearchFrame>
      <RunHistorySearchMenu />
    </RunHistorySearchRoot>
  );
}

export function RunHistorySearch(props: RunHistorySearchProps) {
  return (
    <RunHistorySearchProvider {...props}>
      <RunHistorySearchBar />
    </RunHistorySearchProvider>
  );
}

RunHistorySearch.Provider = RunHistorySearchProvider;
RunHistorySearch.Root = RunHistorySearchRoot;
RunHistorySearch.Frame = RunHistorySearchFrame;
RunHistorySearch.Pills = RunHistorySearchPills;
RunHistorySearch.Input = RunHistorySearchInput;
RunHistorySearch.ResultCount = RunHistorySearchResultCount;
RunHistorySearch.Menu = RunHistorySearchMenu;
