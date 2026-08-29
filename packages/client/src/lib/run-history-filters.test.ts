import { describe, expect, it } from "vitest";
import type { WorkflowExecutionStartSource } from "@wfgraph/shared/lifecycle/execution-contracts";
import {
  addRunFilter,
  autofillRemainder,
  createRunFilter,
  DEFAULT_STATUS_OPTIONS,
  filterRuns,
  formatRunFilterValue,
  isLabelPrefix,
  operatorsForField,
  removeRunFilter,
  toExecutionsQueryInput,
  uniqueNonEmpty,
  type RunFilter,
  type RunHistorySearchRow,
} from "./run-history-filters";

function run(
  overrides: Partial<RunHistorySearchRow> & { id: string }
): RunHistorySearchRow {
  return {
    workflowId: "wf_1",
    workflowName: "Onboarding",
    status: "completed",
    runMode: "live",
    versionKind: "published",
    startSource: "manual",
    startEventName: null,
    entityValue: null,
    workflowRunId: null,
    error: null,
    ...overrides,
  };
}

function filter(partial: Omit<RunFilter, "id">): RunFilter {
  return { id: `f_${partial.field}_${partial.value}`, ...partial };
}

describe("operatorsForField", () => {
  it("offers contains only on free-text fields", () => {
    expect(operatorsForField("status")).toEqual(["is", "is_not"]);
    expect(operatorsForField("event")).toEqual(["is", "is_not", "contains"]);
  });
});

describe("addRunFilter", () => {
  it("drops an exact duplicate rather than stacking the same pill twice", () => {
    const first = createRunFilter({
      field: "status",
      operator: "is",
      value: "failed",
    });
    const copy = { ...first, id: "other" };

    expect(addRunFilter([first], copy)).toEqual([first]);
  });
});

describe("removeRunFilter", () => {
  it("removes by id and leaves the rest", () => {
    const filters = [
      filter({ field: "status", operator: "is", value: "failed" }),
      filter({ field: "mode", operator: "is", value: "test" }),
    ];

    expect(removeRunFilter(filters, filters[0]?.id ?? "")).toEqual([
      filters[1],
    ]);
  });
});

describe("formatRunFilterValue", () => {
  it("prefers the label when one was stored", () => {
    expect(
      formatRunFilterValue(
        filter({
          field: "workflow",
          operator: "is",
          value: "wf_1",
          valueLabel: "Onboarding",
        })
      )
    ).toBe("Onboarding");
  });
});

describe("filterRuns", () => {
  const rows = [
    run({
      id: "exec_1",
      workflowId: "wf_1",
      workflowName: "Onboarding",
      status: "failed",
      runMode: "live",
      startEventName: "user.created",
      entityValue: "user_1",
      error: "timeout",
    }),
    run({
      id: "exec_2",
      workflowId: "wf_2",
      workflowName: "Billing",
      status: "running",
      runMode: "test",
      startSource: "event" as WorkflowExecutionStartSource,
      startEventName: "invoice.paid",
    }),
    run({
      id: "exec_3",
      workflowId: "wf_1",
      workflowName: "Onboarding",
      status: "completed",
      runMode: "live",
    }),
  ];

  it("returns every row when nothing is asked", () => {
    expect(
      filterRuns(rows, { query: "", filters: [] }).map((row) => row.id)
    ).toEqual(["exec_1", "exec_2", "exec_3"]);
  });

  it("treats multiple is filters on one field as any-of", () => {
    const filtered = filterRuns(rows, {
      query: "",
      filters: [
        filter({ field: "status", operator: "is", value: "failed" }),
        filter({ field: "status", operator: "is", value: "running" }),
      ],
    });

    expect(filtered.map((row) => row.id)).toEqual(["exec_1", "exec_2"]);
  });

  it("ands filters on different fields", () => {
    const filtered = filterRuns(rows, {
      query: "",
      filters: [
        filter({ field: "status", operator: "is", value: "failed" }),
        filter({ field: "mode", operator: "is", value: "test" }),
      ],
    });

    expect(filtered).toEqual([]);
  });

  it("excludes with is not", () => {
    const filtered = filterRuns(rows, {
      query: "",
      filters: [
        filter({ field: "status", operator: "is_not", value: "completed" }),
      ],
    });

    expect(filtered.map((row) => row.id)).toEqual(["exec_1", "exec_2"]);
  });

  it("matches contains against the field, not the whole row", () => {
    const filtered = filterRuns(rows, {
      query: "",
      filters: [
        filter({
          field: "event",
          operator: "contains",
          value: "invoice",
        }),
      ],
    });

    expect(filtered.map((row) => row.id)).toEqual(["exec_2"]);
  });

  it("filters by graph kind", () => {
    const withDraft = [
      ...rows,
      run({
        id: "exec_4",
        workflowId: "wf_1",
        workflowName: "Onboarding",
        versionKind: "draft_snapshot",
      }),
    ];

    expect(
      filterRuns(withDraft, {
        query: "",
        filters: [
          filter({ field: "graph", operator: "is", value: "draft_snapshot" }),
        ],
      }).map((row) => row.id)
    ).toEqual(["exec_4"]);
  });

  it("searches name, id, event, entity, and error", () => {
    expect(
      filterRuns(rows, { query: "timeout", filters: [] }).map((row) => row.id)
    ).toEqual(["exec_1"]);
    expect(
      filterRuns(rows, { query: "billing", filters: [] }).map((row) => row.id)
    ).toEqual(["exec_2"]);
    expect(
      filterRuns(rows, { query: "user_1", filters: [] }).map((row) => row.id)
    ).toEqual(["exec_1"]);
  });

  it("matches a free-text search for 'draft' against Graph=Draft rows", () => {
    const withDraft = [
      ...rows,
      run({
        id: "exec_4",
        workflowId: "wf_1",
        workflowName: "Onboarding",
        versionKind: "draft_snapshot",
      }),
    ];

    expect(
      filterRuns(withDraft, { query: "draft", filters: [] }).map(
        (row) => row.id
      )
    ).toEqual(["exec_4"]);
  });
});

describe("toExecutionsQueryInput", () => {
  it("asks for the default statuses when none are picked", () => {
    expect(
      toExecutionsQueryInput({
        filters: [],
        selectedWorkflowIds: [],
        selectedOnly: false,
        limit: 100,
      })
    ).toEqual({
      statuses: [...DEFAULT_STATUS_OPTIONS].toSorted(),
      limit: 100,
    });
  });

  it("sends the statuses that were picked with is", () => {
    expect(
      toExecutionsQueryInput({
        filters: [
          filter({ field: "status", operator: "is", value: "failed" }),
          filter({ field: "status", operator: "is", value: "running" }),
        ],
        selectedWorkflowIds: [],
        selectedOnly: false,
        limit: 50,
      }).statuses
    ).toEqual(["failed", "running"]);
  });

  it("drops is-not statuses from the default set", () => {
    expect(
      toExecutionsQueryInput({
        filters: [
          filter({ field: "status", operator: "is_not", value: "completed" }),
        ],
        selectedWorkflowIds: [],
        selectedOnly: false,
        limit: 100,
      }).statuses
    ).toEqual(
      DEFAULT_STATUS_OPTIONS.filter(
        (status) => status !== "completed"
      ).toSorted()
    );
  });

  it("intersects selected workflows with workflow is filters", () => {
    expect(
      toExecutionsQueryInput({
        filters: [filter({ field: "workflow", operator: "is", value: "wf_2" })],
        selectedWorkflowIds: ["wf_1", "wf_2"],
        selectedOnly: true,
        limit: 100,
      }).workflowIds
    ).toEqual(["wf_2"]);
  });

  it("leaves mode and event filters off the server query", () => {
    const query = toExecutionsQueryInput({
      filters: [
        filter({ field: "mode", operator: "is", value: "test" }),
        filter({ field: "event", operator: "contains", value: "user" }),
      ],
      selectedWorkflowIds: [],
      selectedOnly: false,
      limit: 100,
    });

    expect(query.workflowIds).toBeUndefined();
    expect(query.statuses).toEqual([...DEFAULT_STATUS_OPTIONS].toSorted());
  });
});

describe("isLabelPrefix", () => {
  it("matches a workflow name as it is typed", () => {
    expect(isLabelPrefix("new wor", "New Workflow")).toBe(true);
    expect(isLabelPrefix("Onb", "Onboarding")).toBe(true);
    expect(isLabelPrefix("board", "Onboarding")).toBe(false);
  });
});

describe("autofillRemainder", () => {
  it("returns the untyped tail, keeping the label's own casing", () => {
    expect(autofillRemainder("new wor", "New Workflow")).toBe("kflow");
    expect(autofillRemainder("Onb", "Onboarding")).toBe("oarding");
    expect(autofillRemainder("Onboarding", "Onboarding")).toBe("");
    expect(autofillRemainder("  new wor", "New Workflow")).toBe("kflow");
  });
});

describe("uniqueNonEmpty", () => {
  it("drops blanks and sorts what remains", () => {
    expect(uniqueNonEmpty(["zebra", "", null, "alpha", "zebra"])).toEqual([
      "alpha",
      "zebra",
    ]);
  });
});
