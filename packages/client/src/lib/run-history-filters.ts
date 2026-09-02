import {
  WORKFLOW_EXECUTION_START_SOURCES,
  WORKFLOW_EXECUTION_STATUSES,
  type WorkflowExecutionStartSource,
  type WorkflowExecutionStatus,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import {
  WORKFLOW_VERSION_KINDS,
  type WorkflowVersionKind,
} from "@wfgraph/shared/graph/version-kinds";
import { runGraphLabel } from "#src/lib/workflow-run-labels";

/**
 * The statuses this list asks for when nothing is ticked.
 *
 * `superseded` is a filter a builder can add but never part of the default set:
 * a newest-wins workflow produces one on every reschedule, and unticked they
 * would bury the rows someone came to read.
 */
export const DEFAULT_STATUS_OPTIONS: WorkflowExecutionStatus[] = [
  "running",
  "waiting",
  "failed",
  "completed",
  "canceled",
  "pending",
];

export const RUN_FILTER_FIELDS = [
  "status",
  "workflow",
  "mode",
  "graph",
  "source",
  "event",
  "entity",
] as const;

export type RunFilterField = (typeof RUN_FILTER_FIELDS)[number];

export const RUN_FILTER_OPERATORS = ["is", "is_not", "contains"] as const;

export type RunFilterOperator = (typeof RUN_FILTER_OPERATORS)[number];

export type RunFilter = {
  id: string;
  field: RunFilterField;
  operator: RunFilterOperator;
  value: string;
  /** Shown in the pill when it differs from `value`, e.g. a workflow name. */
  valueLabel?: string;
};

/** The columns the dashboard search can read; extra fields on a row are ignored. */
export type RunHistorySearchRow = {
  id: string;
  workflowId: string;
  workflowName: string;
  status: WorkflowExecutionStatus;
  runMode: "live" | "test";
  versionKind: WorkflowVersionKind;
  versionNumber: number | null;
  startSource: WorkflowExecutionStartSource | null;
  startEventName: string | null;
  entityValue: string | null;
  workflowRunId: string | null;
  error: string | null;
};

export type RunFilterValueOption = {
  value: string;
  label: string;
};

export const RUN_FILTER_FIELD_LABELS: Record<RunFilterField, string> = {
  status: "Status",
  workflow: "Workflow",
  mode: "Recipients",
  graph: "Graph",
  source: "Source",
  event: "Event",
  entity: "Entity",
};

export const RUN_FILTER_OPERATOR_LABELS: Record<RunFilterOperator, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
};

const OPERATORS_BY_FIELD: Record<RunFilterField, readonly RunFilterOperator[]> =
  {
    status: ["is", "is_not"],
    workflow: ["is", "is_not"],
    mode: ["is", "is_not"],
    graph: ["is", "is_not"],
    source: ["is", "is_not"],
    event: ["is", "is_not", "contains"],
    entity: ["is", "is_not", "contains"],
  };

export const MODE_VALUE_OPTIONS: readonly RunFilterValueOption[] = [
  { value: "live", label: "Live" },
  { value: "test", label: "Test" },
];

const GRAPH_LABELS: Record<WorkflowVersionKind, string> = {
  draft_snapshot: "Draft",
  published: "Published",
};

/** "Draft" runs the canvas; "Published" runs a numbered published version. */
export const GRAPH_VALUE_OPTIONS: readonly RunFilterValueOption[] =
  WORKFLOW_VERSION_KINDS.map((value) => ({
    value,
    label: GRAPH_LABELS[value],
  }));

const SOURCE_LABELS: Record<WorkflowExecutionStartSource, string> = {
  event: "Event",
  schedule: "Schedule",
  manual: "Manual",
};

export const SOURCE_VALUE_OPTIONS: readonly RunFilterValueOption[] =
  WORKFLOW_EXECUTION_START_SOURCES.map((value) => ({
    value,
    label: SOURCE_LABELS[value],
  }));

export function operatorsForField(
  field: RunFilterField
): readonly RunFilterOperator[] {
  return OPERATORS_BY_FIELD[field];
}

export function createRunFilter(input: {
  field: RunFilterField;
  operator: RunFilterOperator;
  value: string;
  valueLabel?: string | undefined;
}): RunFilter {
  return {
    id: crypto.randomUUID(),
    field: input.field,
    operator: input.operator,
    value: input.value,
    ...(input.valueLabel !== undefined ? { valueLabel: input.valueLabel } : {}),
  };
}

export function addRunFilter(
  filters: readonly RunFilter[],
  next: RunFilter
): RunFilter[] {
  if (
    filters.some(
      (filter) =>
        filter.field === next.field &&
        filter.operator === next.operator &&
        filter.value === next.value
    )
  ) {
    return [...filters];
  }
  return [...filters, next];
}

export function removeRunFilter(
  filters: readonly RunFilter[],
  id: string
): RunFilter[] {
  return filters.filter((filter) => filter.id !== id);
}

export function formatRunFilterValue(filter: RunFilter): string {
  return filter.valueLabel ?? filter.value;
}

function fieldValue(
  run: RunHistorySearchRow,
  field: RunFilterField
): string | null {
  switch (field) {
    case "status":
      return run.status;
    case "workflow":
      return run.workflowId;
    case "mode":
      return run.runMode;
    case "graph":
      return run.versionKind;
    case "source":
      return run.startSource;
    case "event":
      return run.startEventName;
    case "entity":
      return run.entityValue;
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function equalsField(run: RunHistorySearchRow, filter: RunFilter): boolean {
  const actual = fieldValue(run, filter.field);
  if (actual === null) {
    return false;
  }
  return normalize(actual) === normalize(filter.value);
}

function containsField(run: RunHistorySearchRow, filter: RunFilter): boolean {
  const actual = fieldValue(run, filter.field);
  if (actual === null || filter.value.trim() === "") {
    return false;
  }
  return normalize(actual).includes(normalize(filter.value));
}

function matchesOne(run: RunHistorySearchRow, filter: RunFilter): boolean {
  switch (filter.operator) {
    case "is":
      return equalsField(run, filter);
    case "is_not":
      return !equalsField(run, filter);
    case "contains":
      return containsField(run, filter);
    default: {
      const exhaustive: never = filter.operator;
      return exhaustive;
    }
  }
}

function matchesFieldGroup(
  run: RunHistorySearchRow,
  filters: readonly RunFilter[]
): boolean {
  const positives = filters.filter(
    (filter) => filter.operator === "is" || filter.operator === "contains"
  );
  const negatives = filters.filter((filter) => filter.operator === "is_not");

  if (
    positives.length > 0 &&
    !positives.some((filter) => matchesOne(run, filter))
  ) {
    return false;
  }

  return negatives.every((filter) => matchesOne(run, filter));
}

function runSearchText(run: RunHistorySearchRow): string {
  return [
    run.workflowName,
    run.workflowId,
    run.id,
    run.status,
    run.runMode,
    // The stored kind, so a search for "draft" matches `draft_snapshot` and one
    // for "published" matches `published`.
    run.versionKind,
    // The label the Graph column prints, so a search for "v7" keeps the runs of
    // published version 7.
    runGraphLabel(run),
    run.startSource,
    run.startEventName,
    run.entityValue,
    run.workflowRunId,
    run.error,
  ]
    .filter((value): value is string => value !== null && value !== "")
    .join("\n")
    .toLowerCase();
}

export function filterRuns<T extends RunHistorySearchRow>(
  runs: readonly T[],
  input: { query: string; filters: readonly RunFilter[] }
): T[] {
  const query = input.query.trim().toLowerCase();
  const grouped = new Map<RunFilterField, RunFilter[]>();
  for (const filter of input.filters) {
    const group = grouped.get(filter.field) ?? [];
    group.push(filter);
    grouped.set(filter.field, group);
  }

  return runs.filter((run) => {
    if (query !== "" && !runSearchText(run).includes(query)) {
      return false;
    }
    for (const group of grouped.values()) {
      if (!matchesFieldGroup(run, group)) {
        return false;
      }
    }
    return true;
  });
}

export type RunHistoryServerQuery = {
  workflowIds?: string[];
  statuses: WorkflowExecutionStatus[];
  limit: number;
};

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].toSorted();
}

const EXECUTION_STATUS_SET: ReadonlySet<string> = new Set(
  WORKFLOW_EXECUTION_STATUSES
);

function isExecutionStatus(value: string): value is WorkflowExecutionStatus {
  return EXECUTION_STATUS_SET.has(value);
}

/**
 * Status and workflow predicates the list API already understands. Mode, source,
 * event, entity, and the free-text query stay on the client over the pages that
 * have been loaded.
 */
export function toExecutionsQueryInput(input: {
  filters: readonly RunFilter[];
  selectedWorkflowIds: readonly string[];
  selectedOnly: boolean;
  limit: number;
}): RunHistoryServerQuery {
  const statusIs = input.filters
    .filter((filter) => filter.field === "status" && filter.operator === "is")
    .map((filter) => filter.value)
    .filter(isExecutionStatus);
  const statusIsNot = new Set(
    input.filters
      .filter(
        (filter) => filter.field === "status" && filter.operator === "is_not"
      )
      .map((filter) => filter.value)
  );

  const statuses = (
    statusIs.length > 0 ? statusIs : DEFAULT_STATUS_OPTIONS
  ).filter((status) => !statusIsNot.has(status));

  const workflowIs = uniqueSorted(
    input.filters
      .filter(
        (filter) => filter.field === "workflow" && filter.operator === "is"
      )
      .map((filter) => filter.value)
  );

  let workflowIds: string[] | undefined;
  if (input.selectedOnly && input.selectedWorkflowIds.length > 0) {
    const selected = uniqueSorted(input.selectedWorkflowIds);
    workflowIds =
      workflowIs.length > 0
        ? selected.filter((id) => workflowIs.includes(id))
        : selected;
  } else if (workflowIs.length > 0) {
    workflowIds = workflowIs;
  }

  return {
    statuses: uniqueSorted(statuses),
    limit: input.limit,
    ...(workflowIds !== undefined && workflowIds.length > 0
      ? { workflowIds }
      : {}),
  };
}

/** True when `query` is a prefix of `label`, ignoring case and edge spaces. */
export function isLabelPrefix(query: string, label: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return false;
  }
  return label.toLowerCase().startsWith(needle);
}

/**
 * The untyped tail of a Tokenizer-style completion. Empty when `query` is not a
 * prefix of `label`, so the ghost never invents characters the match does not
 * continue with.
 */
export function autofillRemainder(query: string, label: string): string {
  if (!isLabelPrefix(query, label)) {
    return "";
  }
  return label.slice(query.trim().length);
}

export function uniqueNonEmpty(
  values: readonly (string | null | undefined)[]
): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed === "" || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique.toSorted((a, b) => a.localeCompare(b));
}
