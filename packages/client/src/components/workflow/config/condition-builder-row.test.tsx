import { fireEvent, render, type RenderResult } from "@testing-library/react";
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

/**
 * Search the field picker and take the first path it offers.
 *
 * The popup opens on an arrow key rather than a click: a pointer press reaches
 * the list through events happy-dom does not deliver whole, and the keyboard path
 * is the one a builder filtering a long list takes anyway.
 */
function chooseField(view: RenderResult, query: string) {
  const input = view.getByLabelText("Select field");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.change(input, { target: { value: query } });

  const option = view.getAllByRole("option").at(0);
  if (!option) {
    throw new Error(`No field matched "${query}"`);
  }
  fireEvent.click(option);
}

function openFieldPicker(view: RenderResult) {
  const input = view.getByLabelText("Select field");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  return input;
}

describe("ConditionBuilderRow field picker", () => {
  it("offers every field, grouped by the node that produced it", () => {
    const view = renderRow(
      [...DONOR_FIELDS, ...APPOINTMENT_FIELDS],
      storedModel("becsRef")
    );

    openFieldPicker(view);

    expect(view.getByText("Look Up Donor")).toBeTruthy();
    expect(view.getByText("Created")).toBeTruthy();
    expect(
      view.getAllByRole("option").map((option) => option.textContent)
    ).toEqual([
      "appointment.id",
      "becsRefnullable",
      "emailnullable",
      "firstName",
    ]);
  });

  it("filters the list as the builder types", () => {
    const view = renderRow(DONOR_FIELDS, storedModel("becsRef"));
    const input = openFieldPicker(view);

    fireEvent.change(input, { target: { value: "email" } });

    expect(
      view.getAllByRole("option").map((option) => option.textContent)
    ).toEqual(["emailnullable"]);
  });

  it("finds a field by the node that produced it", () => {
    const view = renderRow(
      [...DONOR_FIELDS, ...APPOINTMENT_FIELDS],
      storedModel("becsRef")
    );
    const input = openFieldPicker(view);

    fireEvent.change(input, { target: { value: "Created" } });

    expect(
      view.getAllByRole("option").map((option) => option.textContent)
    ).toEqual(["appointment.id"]);
  });

  it("says when nothing matches the query", () => {
    const view = renderRow(DONOR_FIELDS, storedModel("becsRef"));
    const input = openFieldPicker(view);

    fireEvent.change(input, { target: { value: "zzzz" } });

    expect(view.getByText("No field matches that.")).toBeTruthy();
    expect(view.queryAllByRole("option")).toEqual([]);
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

    expect(
      (view.getByLabelText("Select field") as HTMLInputElement).value
    ).toBe("gone.path (Unavailable)");

    openFieldPicker(view);

    expect(
      view.getByRole("option", { name: /gone\.path \(Unavailable\)/ })
    ).toBeTruthy();
  });
});
