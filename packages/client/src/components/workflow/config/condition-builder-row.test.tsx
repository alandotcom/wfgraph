import {
  fireEvent,
  render,
  type RenderResult,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { ConditionBuilderRow } from "#src/components/workflow/config/condition-builder-row";
import type { ConditionSelectableField } from "#src/lib/upstream-node-fields";
import {
  parseConditionModel,
  serializeConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

function field(
  path: string,
  sourceNodeLabel: string,
  extra: Partial<ConditionSelectableField> = {}
): ConditionSelectableField {
  return {
    path,
    label: path,
    type: "string",
    sourceNodeId: sourceNodeLabel,
    sourceNodeLabel,
    sourceNodeLabels: extra.sourceNodeLabels ?? [sourceNodeLabel],
    ...extra,
  };
}

const DONOR_FIELDS: ConditionSelectableField[] = [
  field("becsRef", "Look Up Donor", { nullable: true }),
  field("email", "Look Up Donor", { nullable: true }),
  field("firstName", "Look Up Donor"),
];

const APPOINTMENT_FIELDS: ConditionSelectableField[] = [
  field("appointment.id", "Created"),
];

function storedModel(fieldPath: string): string {
  return serializeConditionModel({
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "g",
        logic: "and",
        conditions: [
          {
            id: "r",
            field: fieldPath,
            fieldType: "string",
            operator: "equals",
            value: "",
          },
        ],
      },
    ],
  });
}

function ControlledRow({
  fields,
  initialValue,
  onChange = vi.fn(),
}: {
  fields: ConditionSelectableField[];
  initialValue: string;
  onChange?: (next: { model: string; expression: string }) => void;
}) {
  const [value, setValue] = useState(initialValue);

  return (
    <ConditionBuilderRow
      currentNodeId="condition-1"
      description="Build a condition"
      disabled={false}
      emptyFieldsMessage="No fields"
      fields={fields}
      label="Condition"
      onChange={(next) => {
        setValue(next.model);
        onChange(next);
      }}
      value={value}
    />
  );
}

function renderRow(
  fields: ConditionSelectableField[],
  initialValue: string,
  onChange?: (next: { model: string; expression: string }) => void
) {
  return render(
    <ExtensionCatalogProvider value={emptyExtensionCatalog}>
      <ControlledRow
        fields={fields}
        initialValue={initialValue}
        onChange={onChange}
      />
    </ExtensionCatalogProvider>
  );
}

function chooseField(view: RenderResult, query: string) {
  const input = openFieldPicker(view);
  fireEvent.change(input, { target: { value: query } });

  const option = fieldOptions(input).at(0);
  if (!option) {
    throw new Error(`No field matched "${query}"`);
  }
  fireEvent.click(option);
}

function openFieldPicker(view: RenderResult) {
  fireEvent.click(view.getByRole("button", { name: "Field" }));
  return view.getByPlaceholderText("Search fields");
}

function fieldOptions(input: HTMLElement) {
  const listboxId = input.getAttribute("aria-controls");
  const listbox = listboxId ? document.getElementById(listboxId) : null;
  if (!listbox) {
    throw new Error("Field picker listbox was not rendered");
  }
  return within(listbox).queryAllByRole("option");
}

describe("ConditionBuilderRow field picker", () => {
  it("offers every field, grouped by the node that produced it", () => {
    const view = renderRow(
      [...DONOR_FIELDS, ...APPOINTMENT_FIELDS],
      storedModel("becsRef")
    );

    const input = openFieldPicker(view);

    expect(fieldOptions(input).map((option) => option.textContent)).toEqual([
      "Created: appointment.id",
      "Look Up Donor: becsRef (nullable)",
      "Look Up Donor: email (nullable)",
      "Look Up Donor: firstName",
    ]);
  });

  it("filters the list as the builder types", () => {
    const view = renderRow(DONOR_FIELDS, storedModel("becsRef"));
    const input = openFieldPicker(view);

    fireEvent.change(input, { target: { value: "email" } });

    expect(fieldOptions(input).map((option) => option.textContent)).toEqual([
      "Look Up Donor: email (nullable)",
    ]);
  });

  it("finds a field by the node that produced it", () => {
    const view = renderRow(
      [...DONOR_FIELDS, ...APPOINTMENT_FIELDS],
      storedModel("becsRef")
    );
    const input = openFieldPicker(view);

    fireEvent.change(input, { target: { value: "Created" } });

    expect(fieldOptions(input).map((option) => option.textContent)).toEqual([
      "Created: appointment.id",
    ]);
  });

  it("says when nothing matches the query", () => {
    const view = renderRow(DONOR_FIELDS, storedModel("becsRef"));
    const input = openFieldPicker(view);

    fireEvent.change(input, { target: { value: "zzzz" } });

    expect(view.getByText(/No results/i)).toBeTruthy();
    expect(fieldOptions(input)).toEqual([]);
  });

  it("writes the chosen field onto the rule", () => {
    const onChange = vi.fn();
    const view = renderRow(DONOR_FIELDS, storedModel("becsRef"), onChange);

    chooseField(view, "firstName");

    const written = onChange.mock.calls.at(-1)?.[0] as
      | { model: string }
      | undefined;
    const parsed = parseConditionModel(written?.model ?? "");
    expect(parsed.valid).toBe(true);
    if (parsed.valid) {
      expect(parsed.model.groups[0]?.conditions[0]?.field).toBe("firstName");
    }
  });

  it("keeps a stored path the graph no longer offers", () => {
    const view = renderRow(DONOR_FIELDS, storedModel("gone.path"));

    expect(view.getByRole("button", { name: "Field" }).textContent).toContain(
      "gone.path (Unavailable)"
    );

    openFieldPicker(view);

    expect(
      view.getByRole("option", { name: /gone\.path \(Unavailable\)/ })
    ).toBeTruthy();
  });
});
