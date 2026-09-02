import { getStatusLabel } from "#src/components/workflow/workflow-run-shared";
import {
  autofillRemainder,
  GRAPH_VALUE_OPTIONS,
  isLabelPrefix,
  MODE_VALUE_OPTIONS,
  operatorsForField,
  RUN_FILTER_FIELD_LABELS,
  RUN_FILTER_FIELDS,
  RUN_FILTER_OPERATOR_LABELS,
  SOURCE_VALUE_OPTIONS,
  type RunFilterField,
  type RunFilterOperator,
  type RunFilterValueOption,
} from "#src/lib/run-history-filters";
import { WORKFLOW_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";

export type RunHistoryDraft =
  | { step: "field" }
  | { step: "operator"; field: RunFilterField }
  | { step: "value"; field: RunFilterField; operator: RunFilterOperator };

export const FIELD_STEP: RunHistoryDraft = { step: "field" };

export type WorkflowOption = {
  id: string;
  name: string;
};

export type RunHistoryMenuAction =
  | { type: "pick-field"; field: RunFilterField }
  | {
      type: "pick-operator";
      field: RunFilterField;
      operator: RunFilterOperator;
    }
  | {
      type: "commit";
      field: RunFilterField;
      operator: RunFilterOperator;
      value: string;
      valueLabel?: string | undefined;
    }
  | { type: "search" };

export type RunHistoryMenuItem = {
  id: string;
  label: string;
  detail?: string;
  icon: "search" | "list";
  ghost?: string;
  action: RunHistoryMenuAction;
};

function fieldIcon(field: RunFilterField): "search" | "list" {
  switch (field) {
    case "event":
    case "entity":
      return "search";
    case "status":
    case "workflow":
    case "mode":
    case "graph":
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
      return WORKFLOW_EXECUTION_STATUSES.map((value) => ({
        value,
        label: getStatusLabel(value),
      }));
    case "mode":
      return MODE_VALUE_OPTIONS;
    case "graph":
      return GRAPH_VALUE_OPTIONS;
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

function commitValueLabel(option: RunFilterValueOption): string | undefined {
  return option.label === option.value ? undefined : option.label;
}

export function buildRunHistoryMenuItems(input: {
  draft: RunHistoryDraft;
  query: string;
  workflows: readonly WorkflowOption[];
  eventSuggestions: readonly string[];
  entitySuggestions: readonly string[];
}): RunHistoryMenuItem[] {
  const draft = input.draft;
  const catalog = {
    workflows: input.workflows,
    eventSuggestions: input.eventSuggestions,
    entitySuggestions: input.entitySuggestions,
  };

  if (draft.step === "field") {
    const shortcuts: RunHistoryMenuItem[] = [];
    if (input.query.trim() !== "") {
      for (const field of RUN_FILTER_FIELDS) {
        for (const option of filterValueOptions({ field, ...catalog })) {
          if (!isLabelPrefix(input.query, option.label)) {
            continue;
          }
          const valueLabel = commitValueLabel(option);
          shortcuts.push({
            id: `shortcut:${field}:${option.value}`,
            label: option.label,
            detail: `${RUN_FILTER_FIELD_LABELS[field]} is`,
            icon: fieldIcon(field),
            ghost: autofillRemainder(input.query, option.label),
            action: {
              type: "commit",
              field,
              operator: "is",
              value: option.value,
              valueLabel,
            },
          });
        }
      }
    }

    const fields = RUN_FILTER_FIELDS.filter((field) =>
      matchesQuery(RUN_FILTER_FIELD_LABELS[field], input.query)
    ).map((field) => ({
      id: `field:${field}`,
      label: RUN_FILTER_FIELD_LABELS[field],
      icon: fieldIcon(field),
      action: { type: "pick-field" as const, field },
    }));

    if (input.query.trim() !== "") {
      return [
        ...shortcuts,
        ...fields,
        {
          id: "search",
          label: `Search runs for “${input.query.trim()}”`,
          icon: "search",
          action: { type: "search" },
        },
      ];
    }
    return fields;
  }

  if (draft.step === "operator") {
    const field = draft.field;
    const fieldLabel = RUN_FILTER_FIELD_LABELS[field];
    return operatorsForField(field)
      .filter((operator) =>
        matchesQuery(RUN_FILTER_OPERATOR_LABELS[operator], input.query)
      )
      .map((operator) => ({
        id: `operator:${operator}`,
        label: `${fieldLabel} ${RUN_FILTER_OPERATOR_LABELS[operator]}`,
        icon: fieldIcon(field),
        action: { type: "pick-operator" as const, field, operator },
      }));
  }

  if (draft.step !== "value") {
    const exhaustive: never = draft;
    return exhaustive;
  }

  const options = sortByPrefixFirst(
    filterValueOptions({
      field: draft.field,
      ...catalog,
    }).filter((option) => matchesQuery(option.label, input.query)),
    input.query
  );

  const items: RunHistoryMenuItem[] = options.map((option) => {
    const valueLabel = commitValueLabel(option);
    return {
      id: `value:${option.value}`,
      label: option.label,
      icon: fieldIcon(draft.field),
      ghost: autofillRemainder(input.query, option.label),
      action: {
        type: "commit",
        field: draft.field,
        operator: draft.operator,
        value: option.value,
        valueLabel,
      },
    };
  });

  const typed = input.query.trim();
  if (typed !== "" && items.length === 0 && draft.operator === "contains") {
    items.unshift({
      id: "value:typed",
      label: typed,
      detail: `${RUN_FILTER_FIELD_LABELS[draft.field]} ${RUN_FILTER_OPERATOR_LABELS[draft.operator]}`,
      icon: "search",
      action: {
        type: "commit",
        field: draft.field,
        operator: draft.operator,
        value: typed,
      },
    });
  }

  return items;
}

export function runHistorySearchPlaceholder(
  draft: RunHistoryDraft,
  filterCount: number
): string {
  if (draft.step === "operator") {
    return `${RUN_FILTER_FIELD_LABELS[draft.field]}…`;
  }
  if (draft.step === "value") {
    return `${RUN_FILTER_FIELD_LABELS[draft.field]} ${RUN_FILTER_OPERATOR_LABELS[draft.operator]}…`;
  }
  return filterCount > 0 ? "Add a filter or search…" : "Search runs…";
}

export function runHistoryMenuHeading(draft: RunHistoryDraft): string | null {
  if (draft.step === "operator") {
    return RUN_FILTER_FIELD_LABELS[draft.field];
  }
  if (draft.step === "value") {
    return `${RUN_FILTER_FIELD_LABELS[draft.field]} ${RUN_FILTER_OPERATOR_LABELS[draft.operator]}`;
  }
  return null;
}
