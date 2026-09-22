import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { type ReactElement, useState } from "react";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { loadWorkflowGraphAtom, updateNodeDataAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import type {
  ActionMetadata,
  ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import { TemplateBadgeInput } from "./template-badge-input";

const SOURCE_ONE: ActionMetadata = {
  id: "custom/source-one",
  label: "Source one",
  description: "",
  category: "Custom",
  configFields: [],
  outputFields: [
    {
      path: "fallback",
      description: "First fallback",
    },
    {
      path: "firstAt",
      label: "Shared time",
      description: "First source time",
      type: "timestamp",
    },
  ],
};

const SOURCE_TWO: ActionMetadata = {
  id: "custom/source-two",
  label: "Source two",
  description: "",
  category: "Custom",
  configFields: [],
  outputFields: [
    {
      path: "fallbackTwo",
      description: "Second fallback",
    },
    {
      path: "secondAt",
      label: "Shared time",
      description: "Second source time",
      type: "timestamp",
    },
  ],
};

const catalog: ExtensionCatalog = {
  events: [],
  entities: [
    {
      type: "patient",
      label: "Patient",
      stateFields: [
        {
          path: "state.currentAt",
          label: "Current time",
          description: "Current Entity State time",
          type: "timestamp",
        },
      ],
      stateSchemaDigest: "patient-state",
    },
  ],
  actions: [SOURCE_ONE, SOURCE_TWO],
  integrations: [],
};

function renderWithCatalog(ui: ReactElement) {
  return render(
    <ExtensionCatalogProvider value={catalog}>{ui}</ExtensionCatalogProvider>
  );
}

const noop = () => {};

function ControlledInput({
  fieldType,
  onValueChange = noop,
}: {
  fieldType?: "timestamp" | undefined;
  onValueChange?: ((value: string) => void) | undefined;
}) {
  const [value, setValue] = useState("");

  return (
    <TemplateBadgeInput
      currentNodeId="target_1"
      fieldType={fieldType}
      onChange={(nextValue) => {
        setValue(nextValue);
        onValueChange(nextValue);
      }}
      value={value}
    />
  );
}

function typeFilter(textbox: HTMLElement, filter = "") {
  fireEvent.focus(textbox);
  textbox.textContent = `@${filter}`;
  fireEvent.input(textbox);
}

function groups(): HTMLElement[] {
  return Array.from(
    document.body.querySelectorAll("[data-slot='template-autocomplete-group']")
  ).filter((element): element is HTMLElement => element instanceof HTMLElement);
}

function heading(group: HTMLElement): string {
  return (
    group.querySelector("[data-slot='template-autocomplete-heading']")
      ?.textContent ?? ""
  );
}

function rows(group: HTMLElement): HTMLElement[] {
  return Array.from(
    group.querySelectorAll("[data-slot='template-autocomplete-option']")
  ).filter((element): element is HTMLElement => element instanceof HTMLElement);
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  const nodes: WorkflowNode[] = [
    {
      id: "lifecycle_1",
      position: { x: 0, y: 0 },
      data: {
        label: "Lifecycle",
        type: "lifecycle",
        config: {
          lifecycleRules: {
            startEvents: [],
            cancelEvents: [],
            concurrency: "unlimited",
            trackedEntity: { type: "patient", bindings: {} },
          },
        },
      },
    },
    {
      id: "source_1",
      position: { x: 0, y: 100 },
      data: {
        label: "Patient",
        type: "action",
        config: { actionType: SOURCE_ONE.id },
      },
    },
    {
      id: "source_2",
      position: { x: 0, y: 200 },
      data: {
        label: "Patient",
        type: "action",
        config: { actionType: SOURCE_TWO.id },
      },
    },
    {
      id: "target_1",
      position: { x: 0, y: 300 },
      data: {
        label: "Target",
        type: "action",
        config: { actionType: "Wait" },
      },
    },
  ];
  const edges: WorkflowEdge[] = [
    {
      id: "edge_1",
      source: "lifecycle_1",
      sourceHandle: LIFECYCLE_STARTED_HANDLE,
      target: "source_1",
    },
    { id: "edge_2", source: "source_1", target: "source_2" },
    { id: "edge_3", source: "source_2", target: "target_1" },
  ];

  getDefaultStore().set(loadWorkflowGraphAtom, { nodes, edges });
});

describe("Template autocomplete groups", () => {
  it("keeps same-name nodes and virtual Entity State in separate stable groups", async () => {
    const view = renderWithCatalog(<ControlledInput />);
    typeFilter(view.getByRole("textbox"));

    await waitFor(() => expect(groups()).toHaveLength(3));

    const shownGroups = groups();
    expect(shownGroups.map(heading)).toEqual(["Patient", "Patient", "Patient"]);
    expect(document.body.textContent).not.toContain("Entire output");
    expect(new Set(shownGroups.map((group) => group.dataset.sourceKey)).size).toBe(
      3
    );
    expect(shownGroups.map((group) => rows(group).map((row) => row.textContent))).toEqual(
      [
        [
          "FallbackPatient.fallbackFirst fallback",
          "Shared timePatient.firstAtFirst source time",
        ],
        [
          "Fallback twoPatient.fallbackTwoSecond fallback",
          "Shared timePatient.secondAtSecond source time",
        ],
        ["Current timePatient.state.currentAtCurrent Entity State time"],
      ]
    );
  });

  it("ranks compatible fields inside each source without interleaving groups", async () => {
    const view = renderWithCatalog(<ControlledInput fieldType="timestamp" />);
    typeFilter(view.getByRole("textbox"));

    await waitFor(() => expect(groups()).toHaveLength(3));

    expect(groups().map((group) => rows(group).map((row) => row.textContent))).toEqual(
      [
        [
          "Shared timePatient.firstAtFirst source time",
          "FallbackPatient.fallbackFirst fallback",
        ],
        [
          "Shared timePatient.secondAtSecond source time",
          "Fallback twoPatient.fallbackTwoSecond fallback",
        ],
        ["Current timePatient.state.currentAtCurrent Entity State time"],
      ]
    );
  });

  it("filters by node, full path, label, and description", async () => {
    const view = renderWithCatalog(<ControlledInput fieldType="timestamp" />);
    const textbox = view.getByRole("textbox");

    typeFilter(textbox, "Patient");
    await waitFor(() => expect(groups()).toHaveLength(3));

    typeFilter(textbox, "Patient.secondAt");
    await waitFor(() => {
      expect(groups()).toHaveLength(1);
      expect(rows(groups()[0]!).map((row) => row.textContent)).toEqual([
        "Shared timePatient.secondAtSecond source time",
      ]);
    });

    typeFilter(textbox, "shared TIME");
    await waitFor(() => expect(groups()).toHaveLength(2));

    typeFilter(textbox, "Entity State");
    await waitFor(() => {
      expect(groups()).toHaveLength(1);
      expect(rows(groups()[0]!)[0]?.textContent).toContain("state.currentAt");
    });
  });

  it.each(["keyboard", "mouse"])("selects a multiword node search with the %s", async (method) => {
    getDefaultStore().set(updateNodeDataAtom, {
      id: "source_2",
      data: { label: "Second patient" },
    });
    const onValueChange = vi.fn();
    const view = renderWithCatalog(<ControlledInput onValueChange={onValueChange} />);
    const textbox = view.getByRole("textbox");
    typeFilter(textbox, "Second patient.secondAt");
    await waitFor(() => expect(groups()).toHaveLength(1));
    const option = rows(groups()[0]!)[0]!;
    expect(option.querySelector("[title='Second patient.secondAt']")?.textContent).toBe("Second patient.secondAt");
    if (method === "keyboard") {
      fireEvent.keyDown(window, { key: "Enter" });
    } else {
      fireEvent.mouseDown(option);
    }
    await waitFor(() => expect(onValueChange).toHaveBeenLastCalledWith("{{@source_2:Second patient.secondAt}}"));
  });

  it.each(["\n", "\r\n", "\r"])("ends a search at a line break %j", async (lineBreak) => {
    const view = renderWithCatalog(<ControlledInput />);
    const textbox = view.getByRole("textbox");
    typeFilter(textbox, "Shared time");
    await waitFor(() => expect(groups()).toHaveLength(2));
    typeFilter(textbox, `Shared time${lineBreak}`);
    await waitFor(() => expect(groups()).toHaveLength(0));
  });

  it("uses one option sequence for keyboard scrolling and selection across headings", async () => {
    const scrollIntoView = vi.fn();
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
      scrollIntoView
    );
    let latestValue = "";
    const view = renderWithCatalog(
      <ControlledInput
        fieldType="timestamp"
        onValueChange={(value) => {
          latestValue = value;
        }}
      />
    );
    typeFilter(view.getByRole("textbox"));

    await waitFor(() => expect(groups()).toHaveLength(3));
    for (let index = 0; index < 4; index += 1) {
      fireEvent.keyDown(window, { key: "ArrowDown" });
    }

    await waitFor(() => {
      const scrolled = scrollIntoView.mock.instances.at(-1);
      expect(scrolled).toBeInstanceOf(HTMLElement);
      expect((scrolled as HTMLElement).textContent).toContain("state.currentAt");
    });

    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => {
      expect(latestValue).toBe(
        "{{@$entity:patient|Patient.state.currentAt}}"
      );
    });

  });

  it("selects the intended same-name source with the mouse", async () => {
    let latestValue = "";
    const view = renderWithCatalog(
      <ControlledInput
        fieldType="timestamp"
        onValueChange={(value) => {
          latestValue = value;
        }}
      />
    );
    typeFilter(view.getByRole("textbox"));

    await waitFor(() => expect(groups()).toHaveLength(3));
    fireEvent.mouseDown(rows(groups()[1]!)[0]!);

    await waitFor(() => {
      expect(latestValue).toBe("{{@source_2:Patient.secondAt}}");
    });
  });
});
