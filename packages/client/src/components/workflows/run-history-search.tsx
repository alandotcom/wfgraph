import { ListFilter, Search, XIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useId,
  useRef,
  useState,
} from "react";
import { useDomEvent } from "#src/hooks/effects";
import {
  addRunFilter,
  autofillRemainder,
  createRunFilter,
  formatRunFilterValue,
  isLabelPrefix,
  MODE_VALUE_OPTIONS,
  operatorsForField,
  removeRunFilter,
  RUN_FILTER_FIELD_LABELS,
  RUN_FILTER_FIELDS,
  RUN_FILTER_OPERATOR_LABELS,
  SOURCE_VALUE_OPTIONS,
  STATUS_VALUE_OPTIONS,
  type RunFilter,
  type RunFilterField,
  type RunFilterOperator,
  type RunFilterValueOption,
} from "#src/lib/run-history-filters";
import { cn } from "@wfgraph/shared/utils";

type Draft =
  | { step: "field" }
  | { step: "operator"; field: RunFilterField }
  | { step: "value"; field: RunFilterField; operator: RunFilterOperator };

type MenuItem = {
  id: string;
  label: string;
  detail?: string;
  icon: "search" | "list";
  /** Untyped tail of a Tokenizer completion, shown as ghost text in the input. */
  ghost?: string;
  activate: () => void;
};

type WorkflowOption = {
  id: string;
  name: string;
};

type RunHistorySearchProps = {
  query: string;
  onQueryChange: (query: string) => void;
  filters: readonly RunFilter[];
  onFiltersChange: (filters: RunFilter[]) => void;
  resultCount: number;
  workflows: readonly WorkflowOption[];
  eventSuggestions: readonly string[];
  entitySuggestions: readonly string[];
};

const FIELD_STEP: Draft = { step: "field" };

/** Shared so the ghost overlay and the input paint on the same baseline. */
const SEARCH_FIELD_TYPE = "h-5 font-sans text-xs leading-5";

function fieldIcon(field: RunFilterField): "search" | "list" {
  switch (field) {
    case "event":
    case "entity":
      return "search";
    case "status":
    case "workflow":
    case "mode":
    case "source":
      return "list";
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

function filterValueOptions(input: {
  field: RunFilterField;
  workflows: readonly WorkflowOption[];
  eventSuggestions: readonly string[];
  entitySuggestions: readonly string[];
}): readonly RunFilterValueOption[] {
  switch (input.field) {
    case "status":
      return STATUS_VALUE_OPTIONS;
    case "mode":
      return MODE_VALUE_OPTIONS;
    case "source":
      return SOURCE_VALUE_OPTIONS;
    case "workflow":
      return input.workflows.map((workflow) => ({
        value: workflow.id,
        label: workflow.name,
      }));
    case "event":
      return input.eventSuggestions.map((value) => ({ value, label: value }));
    case "entity":
      return input.entitySuggestions.map((value) => ({ value, label: value }));
    default: {
      const exhaustive: never = input.field;
      return exhaustive;
    }
  }
}

function matchesQuery(label: string, query: string): boolean {
  if (query.trim() === "") {
    return true;
  }
  return label.toLowerCase().includes(query.trim().toLowerCase());
}

function sortByPrefixFirst(
  options: readonly RunFilterValueOption[],
  query: string
): RunFilterValueOption[] {
  return options.toSorted((left, right) => {
    const leftPrefix = isLabelPrefix(query, left.label) ? 0 : 1;
    const rightPrefix = isLabelPrefix(query, right.label) ? 0 : 1;
    if (leftPrefix !== rightPrefix) {
      return leftPrefix - rightPrefix;
    }
    return left.label.localeCompare(right.label);
  });
}

function MenuIcon({ kind }: { kind: "search" | "list" }) {
  if (kind === "search") {
    return <Search className="size-3.5 text-muted-foreground" />;
  }
  return <ListFilter className="size-3.5 text-muted-foreground" />;
}

export function RunHistorySearch({
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  resultCount,
  workflows,
  eventSuggestions,
  entitySuggestions,
}: RunHistorySearchProps) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(FIELD_STEP);
  const [highlighted, setHighlighted] = useState(0);

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
    setDraft(FIELD_STEP);
    onQueryChange("");
    setHighlighted(0);
    setMenuOpen(true);
  };

  const menuItems: readonly MenuItem[] = (() => {
    if (draft.step === "field") {
      const shortcuts: MenuItem[] = [];
      if (query.trim() !== "") {
        for (const field of RUN_FILTER_FIELDS) {
          for (const option of filterValueOptions({
            field,
            workflows,
            eventSuggestions,
            entitySuggestions,
          })) {
            if (!isLabelPrefix(query, option.label)) {
              continue;
            }
            shortcuts.push({
              id: `shortcut:${field}:${option.value}`,
              label: option.label,
              detail: `${RUN_FILTER_FIELD_LABELS[field]} is`,
              icon: fieldIcon(field),
              ghost: autofillRemainder(query, option.label),
              activate: () => {
                commitFilter(
                  field,
                  "is",
                  option.value,
                  option.label === option.value ? undefined : option.label
                );
              },
            });
          }
        }
      }

      const fields = RUN_FILTER_FIELDS.filter((field) =>
        matchesQuery(RUN_FILTER_FIELD_LABELS[field], query)
      ).map((field) => ({
        id: `field:${field}`,
        label: RUN_FILTER_FIELD_LABELS[field],
        icon: fieldIcon(field),
        activate: () => {
          setDraft({ step: "operator", field });
          onQueryChange("");
          setHighlighted(0);
        },
      }));

      if (query.trim() !== "") {
        return [
          ...shortcuts,
          ...fields,
          {
            id: "search",
            label: `Search runs for “${query.trim()}”`,
            icon: "search" as const,
            activate: () => {
              setMenuOpen(false);
              setDraft(FIELD_STEP);
            },
          },
        ];
      }
      return fields;
    }

    if (draft.step === "operator") {
      const fieldLabel = RUN_FILTER_FIELD_LABELS[draft.field];
      return operatorsForField(draft.field)
        .filter((operator) =>
          matchesQuery(RUN_FILTER_OPERATOR_LABELS[operator], query)
        )
        .map((operator) => ({
          id: `operator:${operator}`,
          label: `${fieldLabel} ${RUN_FILTER_OPERATOR_LABELS[operator]}`,
          icon: fieldIcon(draft.field),
          activate: () => {
            setDraft({ step: "value", field: draft.field, operator });
            onQueryChange("");
            setHighlighted(0);
          },
        }));
    }

    const options = sortByPrefixFirst(
      filterValueOptions({
        field: draft.field,
        workflows,
        eventSuggestions,
        entitySuggestions,
      }).filter((option) => matchesQuery(option.label, query)),
      query
    );

    const items: MenuItem[] = options.map((option) => ({
      id: `value:${option.value}`,
      label: option.label,
      icon: fieldIcon(draft.field),
      ghost: autofillRemainder(query, option.label),
      activate: () => {
        commitFilter(
          draft.field,
          draft.operator,
          option.value,
          option.label === option.value ? undefined : option.label
        );
      },
    }));

    const typed = query.trim();
    const canTypeValue = operatorsForField(draft.field).includes("contains");
    if (
      typed !== "" &&
      items.length === 0 &&
      canTypeValue &&
      !options.some(
        (option) => option.value === typed || option.label === typed
      )
    ) {
      items.unshift({
        id: "value:typed",
        label: typed,
        detail: `${RUN_FILTER_FIELD_LABELS[draft.field]} ${RUN_FILTER_OPERATOR_LABELS[draft.operator]}`,
        icon: "search",
        activate: () => {
          commitFilter(draft.field, draft.operator, typed);
        },
      });
    }

    return items;
  })();

  const safeHighlight =
    menuItems.length === 0 ? 0 : Math.min(highlighted, menuItems.length - 1);

  const closeMenu = () => {
    setMenuOpen(false);
    setDraft(FIELD_STEP);
    setHighlighted(0);
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

  const goBack = () => {
    if (draft.step === "value") {
      setDraft({ step: "operator", field: draft.field });
      onQueryChange("");
      setHighlighted(0);
      return;
    }
    if (draft.step === "operator") {
      setDraft(FIELD_STEP);
      onQueryChange("");
      setHighlighted(0);
      return;
    }
    closeMenu();
  };

  const placeholder = (): string => {
    if (draft.step === "operator") {
      return `${RUN_FILTER_FIELD_LABELS[draft.field]}…`;
    }
    if (draft.step === "value") {
      return `${RUN_FILTER_FIELD_LABELS[draft.field]} ${RUN_FILTER_OPERATOR_LABELS[draft.operator]}…`;
    }
    return filters.length > 0 ? "Add a filter or search…" : "Search runs…";
  };

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

    if (event.key === "Tab" && menuItems[safeHighlight]?.id !== "search") {
      const item = menuItems[safeHighlight];
      if (
        item &&
        (item.ghost ||
          draft.step === "value" ||
          item.id.startsWith("shortcut:"))
      ) {
        event.preventDefault();
        item.activate();
      }
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const item = menuItems[safeHighlight];
      if (item) {
        item.activate();
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

  const activeDescendant =
    menuOpen && menuItems[safeHighlight]
      ? `${listId}-${menuItems[safeHighlight].id}`
      : undefined;
  const ghost =
    menuOpen && query !== "" ? (menuItems[safeHighlight]?.ghost ?? "") : "";

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
            placeholder={placeholder()}
            ref={inputRef}
            role="combobox"
            spellCheck={false}
            value={query}
          />
        </div>
        <span className="shrink-0 pr-0.5 text-muted-foreground text-xs/relaxed tabular-nums">
          {resultCount} {resultCount === 1 ? "result" : "results"}
        </span>
      </div>

      {menuOpen ? (
        <div
          className="absolute z-50 mt-1 w-full origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
          id={listId}
          role="listbox"
        >
          {draft.step !== "field" ? (
            <div className="border-b px-2 py-1.5 text-muted-foreground text-xs">
              {draft.step === "operator"
                ? RUN_FILTER_FIELD_LABELS[draft.field]
                : `${RUN_FILTER_FIELD_LABELS[draft.field]} ${RUN_FILTER_OPERATOR_LABELS[draft.operator]}`}
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
                    item.activate();
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
