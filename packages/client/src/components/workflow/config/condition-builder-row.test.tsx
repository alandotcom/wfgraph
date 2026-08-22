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

/**
 * The row exactly as the Condition node mounts it, down to the words on its
 * header and its buttons: those are what a builder reads and what a screen
 * reader announces, so a harness with a label of its own would leave the
 * shipping ones untested.
 */
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
      editActionName="condition"
      emptyFieldsMessage="No fields"
      fields={fields}
      label="Continue when"
      onChange={(next) => {
        setValue(next.model);
        onChange(next);
      }}
      stickyHeader
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

/**
 * Open the row's controls.
 *
 * The row reads as text until its Edit button is pressed, so every case about a
 * control goes through here first.
 */
function enterEdit(view: RenderResult) {
  fireEvent.click(view.getByRole("button", { name: "Edit condition" }));
}

describe("ConditionBuilderRow field picker", () => {
  it("offers every field, grouped by the node that produced it", () => {
    const view = renderRow(
      [...DONOR_FIELDS, ...APPOINTMENT_FIELDS],
      storedModel("becsRef")
    );

    enterEdit(view);
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
    enterEdit(view);
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
    enterEdit(view);
    const input = openFieldPicker(view);

    fireEvent.change(input, { target: { value: "Created" } });

    expect(
      view.getAllByRole("option").map((option) => option.textContent)
    ).toEqual(["appointment.id"]);
  });

  it("says when nothing matches the query", () => {
    const view = renderRow(DONOR_FIELDS, storedModel("becsRef"));
    enterEdit(view);
    const input = openFieldPicker(view);

    fireEvent.change(input, { target: { value: "zzzz" } });

    expect(view.getByText("No field matches that.")).toBeTruthy();
    expect(view.queryAllByRole("option")).toEqual([]);
  });

  it("writes the chosen field onto the rule", () => {
    const onChange = vi.fn();
    const view = renderRow(DONOR_FIELDS, storedModel("becsRef"), onChange);

    enterEdit(view);
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

    enterEdit(view);
    expect(
      (view.getByLabelText("Select field") as HTMLInputElement).value
    ).toBe("gone.path (Unavailable)");

    openFieldPicker(view);

    expect(
      view.getByRole("option", { name: /gone\.path \(Unavailable\)/ })
    ).toBeTruthy();
  });
});

describe("ConditionBuilderRow view mode", () => {
  function twoGroupModel(): string {
    return serializeConditionModel({
      version: 2,
      groupLogic: "or",
      groups: [
        {
          id: "g1",
          logic: "and",
          conditions: [
            {
              id: "r1",
              field: "email",
              fieldType: "string",
              operator: "contains",
              value: "@example.com",
            },
            {
              id: "r2",
              field: "firstName",
              fieldType: "string",
              operator: "equals",
              value: "Ada",
            },
          ],
        },
        {
          id: "g2",
          logic: "and",
          conditions: [
            {
              id: "r3",
              field: "becsRef",
              fieldType: "string",
              operator: "is_set",
            },
          ],
        },
      ],
    });
  }

  // Every word of the summary comes from the same option tables the pickers are
  // built from, so what a builder reads back is what they picked.
  it("reads each rule back as a line of text", () => {
    const view = renderRow(DONOR_FIELDS, twoGroupModel());

    expect(view.getByText("2 conditions")).toBeTruthy();
    expect(view.getByText("1 condition")).toBeTruthy();
    expect(view.getByText(/contains/)).toBeTruthy();
    expect(view.getByText(/@example.com/)).toBeTruthy();
    expect(view.getByText(/is set/)).toBeTruthy();
    // The joiner between the two groups, which is the model's own group logic.
    expect(view.getByText("OR")).toBeTruthy();

    expect(view.queryByLabelText("Select field")).toBeNull();
  });

  it("switches between its two modes with Edit and Done", () => {
    const view = renderRow(DONOR_FIELDS, storedModel("becsRef"));

    fireEvent.click(view.getByRole("button", { name: "Edit condition" }));
    expect(view.getByLabelText("Select field")).toBeTruthy();

    fireEvent.click(
      view.getByRole("button", { name: "Done editing condition" })
    );
    expect(view.queryByLabelText("Select field")).toBeNull();
  });

  // Nothing configured has no view to show, so the one button both seeds the
  // model and opens the editor rather than leaving the builder to press Edit
  // afterwards.
  it("opens the editor from the button that seeds the first rule", () => {
    const view = renderRow(DONOR_FIELDS, "");

    expect(view.queryByRole("button", { name: "Edit condition" })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Configure condition" }));

    expect(view.getByLabelText("Select field")).toBeTruthy();
  });

  it("opens the row's help on a click", () => {
    const view = renderRow(DONOR_FIELDS, storedModel("becsRef"));

    expect(view.queryByText("Build a condition")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "About Continue when" }));

    expect(view.getByText("Build a condition")).toBeTruthy();
  });
});

describe("ConditionBuilderRow view mode names what a rule still owes", () => {
  function stringRule(
    fieldPath: string,
    value: string,
    operator: "equals" | "contains" = "equals"
  ): string {
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
              operator,
              value,
            },
          ],
        },
      ],
    });
  }

  // The Condition node seeds a rule with an empty right-hand side and stores an
  // empty expression beside it. That rule opens in view, and a summary reading
  // "email equals" with nothing after it is a rule that looks finished. The
  // canvas badges it and Publish refuses it; this is the surface that has to say
  // why.
  it("names a rule whose value is still blank", () => {
    const view = renderRow(DONOR_FIELDS, stringRule("email", ""));

    expect(view.getByText("Text conditions require a value")).toBeTruthy();
  });

  it("says nothing about a rule that is ready to run", () => {
    const view = renderRow(
      DONOR_FIELDS,
      stringRule("email", "ada@example.com")
    );

    expect(view.queryByText("Text conditions require a value")).toBeNull();
    expect(view.getByText(/ada@example.com/)).toBeTruthy();
  });

  // The picker deliberately selects nothing when the stored value is no longer
  // one the field names, so the summary saying "equals cancelled" and Edit
  // showing an empty box were two surfaces disagreeing about the same rule.
  it("names a value the field no longer offers", () => {
    const withEnum = [
      field("status", "Look Up Donor", { enumValues: ["confirmed", "booked"] }),
    ];
    const view = renderRow(withEnum, stringRule("status", "cancelled"));

    expect(view.getByText(/no longer offers this value/)).toBeTruthy();
  });

  it("says nothing about a value the field still offers", () => {
    const withEnum = [
      field("status", "Look Up Donor", { enumValues: ["confirmed", "booked"] }),
    ];
    const view = renderRow(withEnum, stringRule("status", "confirmed"));

    expect(view.queryByText(/no longer offers this value/)).toBeNull();
  });

  // The field picker marks a path the graph no longer offers; the summary marks
  // it the same way, out of the same helper.
  it("marks a field the graph no longer offers", () => {
    const view = renderRow(DONOR_FIELDS, stringRule("gone.path", "x"));

    expect(view.getByText("gone.path (Unavailable)")).toBeTruthy();
  });
});
