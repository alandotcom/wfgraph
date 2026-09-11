import { fireEvent, render, type RenderResult } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import {
  applyOperatorValueToCondition,
  getOperatorOptionsByFieldType,
} from "#src/components/workflow/config/condition-builder-row-logic";
import { ConditionBuilderRow } from "#src/components/workflow/config/condition-builder-row";
import type { ConditionSelectableField } from "#src/lib/upstream-node-fields";
import {
  parseConditionModel,
  serializeConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { formatTemplateToken } from "@wfgraph/shared/graph/node-references";

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

/** Resend's email tags: a payload key nobody can list ahead of the run. */
const TAG_FIELDS: ConditionSelectableField[] = [
  field("data.email_id", "Delivered"),
  field("data.tags", "Delivered", { openRecord: true }),
];

/** A stored rule reaching into the tags record, its key named or not. */
function recordModel(recordKey: string): string {
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
            field: "data.tags",
            recordKey,
            fieldType: "string",
            operator: "equals",
            value: "",
          },
        ],
      },
    ],
  });
}

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
  setOperatorsRequireEnumValues,
}: {
  fields: ConditionSelectableField[];
  initialValue: string;
  onChange?:
    | ((next: { model: string; expression: string }) => void)
    | undefined;
  setOperatorsRequireEnumValues?: boolean | undefined;
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
      setOperatorsRequireEnumValues={setOperatorsRequireEnumValues}
      stickyHeader
      value={value}
    />
  );
}

function renderRow(
  fields: ConditionSelectableField[],
  initialValue: string,
  onChange?: (next: { model: string; expression: string }) => void,
  options?: { setOperatorsRequireEnumValues?: boolean | undefined }
) {
  return render(
    <ExtensionCatalogProvider value={emptyExtensionCatalog}>
      <ControlledRow
        fields={fields}
        initialValue={initialValue}
        onChange={onChange}
        setOperatorsRequireEnumValues={options?.setOperatorsRequireEnumValues}
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

/** The rule the last write put in the model. */
function writtenRule(onChange: ReturnType<typeof vi.fn>) {
  const written = onChange.mock.calls.at(-1)?.[0] as
    | { model: string }
    | undefined;
  const parsed = parseConditionModel(written?.model ?? "");
  return parsed.valid ? parsed.model.groups[0]?.conditions[0] : undefined;
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

  // A step's label is whatever the builder typed, so it reaches the picker as a
  // group key. Grouping into a plain object files "__proto__" onto the
  // prototype, and the section it names never reaches the list.
  it("offers the fields of a step named __proto__", () => {
    const view = renderRow(
      [...APPOINTMENT_FIELDS, field("payload.id", "__proto__")],
      storedModel("appointment.id")
    );

    enterEdit(view);
    openFieldPicker(view);

    expect(view.getByText("__proto__")).toBeTruthy();
    expect(
      view.getAllByRole("option").map((option) => option.textContent)
    ).toEqual(["payload.id", "appointment.id"]);
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

  // The record is an ordinary row now. It says what it is rather than telling
  // somebody to type a dotted path into a field search.
  it("offers an open record as an ordinary row", () => {
    const view = renderRow(TAG_FIELDS, storedModel("data.email_id"));
    enterEdit(view);
    const input = openFieldPicker(view);

    fireEvent.change(input, { target: { value: "data.tags" } });

    const option = view.getAllByRole("option").at(0);
    expect(option?.textContent).toContain("One key of this record");
    expect(option?.getAttribute("data-disabled")).toBeNull();
  });

  // The Key box is the whole point: an Event carries whatever tags its sender
  // attached, so a name nothing in this graph sets has to be writable.
  it("takes a key no node in the graph names", () => {
    const onChange = vi.fn();
    const view = renderRow(TAG_FIELDS, storedModel("data.email_id"), onChange);

    enterEdit(view);
    chooseField(view, "data.tags");
    fireEvent.change(view.getByLabelText("Key"), {
      target: { value: "order_id" },
    });

    expect(writtenRule(onChange)).toMatchObject({
      field: "data.tags",
      recordKey: "order_id",
    });
  });

  it("leaves the rule unfinished until the key is named", () => {
    const onChange = vi.fn();
    const view = renderRow(TAG_FIELDS, storedModel("data.email_id"), onChange);

    enterEdit(view);
    chooseField(view, "data.tags");

    // Comparing the record itself is an object no arrival equals, so the rule
    // has to refuse rather than compile.
    expect(writtenRule(onChange)).toMatchObject({
      field: "data.tags",
      recordKey: "",
    });
    expect(view.getByLabelText("Key")).toHaveProperty("value", "");
    const written = onChange.mock.calls.at(-1)?.[0] as
      | { expression: string }
      | undefined;
    expect(written?.expression).toBe("");
  });

  it("keeps the operator and the value while the key is edited", () => {
    const onChange = vi.fn();
    const view = renderRow(TAG_FIELDS, recordModel("order_id"), onChange);

    enterEdit(view);
    fireEvent.change(view.getByLabelText("Key"), {
      target: { value: "campaign" },
    });

    expect(writtenRule(onChange)).toMatchObject({
      field: "data.tags",
      recordKey: "campaign",
      operator: "equals",
      fieldType: "string",
    });
  });

  it("preserves an open-record key when an operator is rewritten", () => {
    const rewritten = applyOperatorValueToCondition(
      {
        id: "r",
        field: "data.tags",
        recordKey: "order_id",
        fieldType: "string",
        operator: "equals",
        value: "",
      },
      "is_not_set"
    );

    expect(rewritten).toMatchObject({
      field: "data.tags",
      recordKey: "order_id",
      operator: "is_not_set",
    });
  });

  it("offers presence operators for an arbitrary key of an open record", () => {
    expect(getOperatorOptionsByFieldType("string", true)).toEqual(
      expect.arrayContaining([
        { value: "is_set", label: "is set" },
        { value: "is_not_set", label: "is not set" },
      ])
    );
  });

  it("offers set operators on every string field by default", () => {
    const setOperators = expect.arrayContaining([
      { value: "is_one_of", label: "is one of" },
      { value: "is_not_one_of", label: "is not one of" },
    ]);
    expect(
      getOperatorOptionsByFieldType("string", false, ["confirmed", "booked"])
    ).toEqual(setOperators);
    expect(getOperatorOptionsByFieldType("string", false)).toEqual(
      setOperators
    );
  });

  it("offers set operators only for enumerated strings when asked to", () => {
    const restricted = { setOperatorsRequireEnumValues: true };
    expect(
      getOperatorOptionsByFieldType(
        "string",
        false,
        ["confirmed", "booked"],
        restricted
      )
    ).toEqual(
      expect.arrayContaining([{ value: "is_one_of", label: "is one of" }])
    );
    expect(
      getOperatorOptionsByFieldType("string", false, undefined, restricted)
    ).not.toEqual(
      expect.arrayContaining([{ value: "is_one_of", label: "is one of" }])
    );
  });

  it("carries a scalar enum value into and out of a set operator", () => {
    const setRule = applyOperatorValueToCondition(
      {
        id: "r",
        field: "status",
        fieldType: "string",
        operator: "equals",
        value: "confirmed",
      },
      "is_one_of"
    );
    expect(setRule).toMatchObject({
      operator: "is_one_of",
      values: ["confirmed"],
    });
    expect(
      setRule && applyOperatorValueToCondition(setRule, "equals")
    ).toMatchObject({ operator: "equals", value: "confirmed" });
  });

  it("preserves an open-record key when a timestamp operator is rewritten", () => {
    const rewritten = applyOperatorValueToCondition(
      {
        id: "r",
        field: "data.tags",
        recordKey: "occurred.at",
        fieldType: "timestamp",
        operator: "within_next",
        amount: 1,
        unit: "days",
      },
      "after"
    );

    expect(rewritten).toMatchObject({
      field: "data.tags",
      recordKey: "occurred.at",
      operator: "after",
    });
  });

  // Reached either way, the rule is the same, and the Key box is the one place
  // the key is read back.
  it("fills the Key box from a stored rule", () => {
    const view = renderRow(TAG_FIELDS, recordModel("order_id"));

    enterEdit(view);
    expect(view.getByLabelText("Key")).toHaveProperty("value", "order_id");
    expect(view.queryByText(/Unavailable/)).toBeNull();
  });

  // The key is its own field rather than a segment of the path, so a name the
  // path grammar could not carry as one segment is still writable.
  it("takes a key holding a dot", () => {
    const onChange = vi.fn();
    const view = renderRow(TAG_FIELDS, recordModel("order_id"), onChange);

    enterEdit(view);
    fireEvent.change(view.getByLabelText("Key"), {
      target: { value: "order.id" },
    });

    expect(writtenRule(onChange)).toMatchObject({ recordKey: "order.id" });
    expect(view.getByLabelText("Key")).toHaveProperty("value", "order.id");
  });

  it("draws no Key box for an ordinary field", () => {
    const view = renderRow(TAG_FIELDS, storedModel("data.email_id"));

    enterEdit(view);
    expect(view.queryByLabelText("Key")).toBeNull();
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

  it("reads a template token as the node's label, not its id", () => {
    const token = formatTemplateToken({
      nodeId: "V1StGXR8_Z5jdHi6B-myT",
      nodeLabel: "Lifecycle",
      fieldPath: "data.email_id",
    });
    const view = renderRow(DONOR_FIELDS, stringRule("email", token));

    expect(view.getByText(/Lifecycle.data.email_id/)).toBeTruthy();
    expect(view.queryByText(/V1StGXR8_Z5jdHi6B-myT/)).toBeNull();
    expect(view.queryByText(/\{\{@/)).toBeNull();
  });

  it("keeps the node id out of Compiled CEL while editing a template value", () => {
    const token = formatTemplateToken({
      nodeId: "V1StGXR8_Z5jdHi6B-myT",
      nodeLabel: "Lifecycle",
      fieldPath: "data.email_id",
    });
    const view = renderRow(DONOR_FIELDS, stringRule("email", token));

    fireEvent.click(view.getByRole("button", { name: "Edit condition" }));

    expect(view.getByText(/Compiled CEL/).textContent).toContain(
      "Lifecycle.data.email_id"
    );
    expect(view.getByText(/Compiled CEL/).textContent).not.toContain(
      "V1StGXR8_Z5jdHi6B-myT"
    );
  });

  // The picker deliberately selects nothing when the stored value is no longer
  // one the field names, so the summary saying "equals cancelled" and Edit
  // showing an empty box were two surfaces disagreeing about the same rule.
  it("names a value the field no longer offers", () => {
    const withEnum = [
      field("status", "Look Up Donor", { enumValues: ["confirmed", "booked"] }),
    ];
    const view = renderRow(withEnum, stringRule("status", "cancelled"));

    expect(view.getByText(/no longer offers/)).toBeTruthy();
  });

  it("names a stale value in an enum set", () => {
    const withEnum = [
      field("status", "Look Up Donor", { enumValues: ["confirmed", "booked"] }),
    ];
    const view = renderRow(
      withEnum,
      serializeConditionModel({
        version: 2,
        groupLogic: "and",
        groups: [
          {
            id: "g",
            logic: "and",
            conditions: [
              {
                id: "r",
                field: "status",
                fieldType: "string",
                operator: "is_one_of",
                values: ["confirmed", "cancelled"],
              },
            ],
          },
        ],
      })
    );

    expect(
      view.getByText(/no longer offers one or more selected values/)
    ).toBeTruthy();
  });

  it("says nothing about a value the field still offers", () => {
    const withEnum = [
      field("status", "Look Up Donor", { enumValues: ["confirmed", "booked"] }),
    ];
    const view = renderRow(withEnum, stringRule("status", "confirmed"));

    expect(view.queryByText(/no longer offers/)).toBeNull();
  });

  it("allows substring operands that are not exact enum values", () => {
    const withEnum = [
      field("status", "Look Up Donor", { enumValues: ["confirmed", "booked"] }),
    ];
    const view = renderRow(withEnum, stringRule("status", "firm", "contains"));

    expect(view.queryByText(/no longer offers/)).toBeNull();
  });

  it("selects multiple offered values for an enum set operator", () => {
    const onChange = vi.fn();
    const withEnum = [
      field("status", "Look Up Donor", {
        enumValues: ["confirmed", "booked"],
        enumLabels: { confirmed: "Confirmed", booked: "Booked" },
      }),
    ];
    const view = renderRow(
      withEnum,
      stringRule("status", "confirmed"),
      onChange
    );

    enterEdit(view);
    fireEvent.click(view.getByRole("combobox", { name: "status operator" }));
    const operator = view.getByRole("option", { name: "is one of" });
    fireEvent.pointerDown(operator);
    fireEvent.click(operator);

    const values = view.getByLabelText("Select status values");
    fireEvent.keyDown(values, { key: "ArrowDown" });
    fireEvent.click(view.getByRole("option", { name: "Booked" }));
    fireEvent.keyDown(values, { key: "Escape" });

    expect(writtenRule(onChange)).toMatchObject({
      field: "status",
      operator: "is_one_of",
      values: ["confirmed", "booked"],
    });
    expect(onChange.mock.calls.at(-1)?.[0].expression).toContain(
      'payload.status in ["confirmed", "booked"]'
    );

    fireEvent.click(view.getByRole("button", { name: "Remove Confirmed" }));
    expect(writtenRule(onChange)).toMatchObject({ values: ["booked"] });

    fireEvent.click(view.getByRole("button", { name: "Remove Booked" }));
    expect(writtenRule(onChange)).toMatchObject({ values: [] });
    expect(onChange.mock.calls.at(-1)?.[0].expression).toBe("");
  });

  // The field picker marks a path the graph no longer offers; the summary marks
  // it the same way, out of the same helper.
  it("marks a field the graph no longer offers", () => {
    const view = renderRow(DONOR_FIELDS, stringRule("gone.path", "x"));

    expect(view.getByText("gone.path (Unavailable)")).toBeTruthy();
  });

  it("reads a template value as the node label, not the node id", () => {
    const token = "{{@V1StGXR8_Z5jdHi6B-myT:Lifecycle.data.email_id}}";
    const view = renderRow(
      APPOINTMENT_FIELDS,
      stringRule("appointment.id", token)
    );

    expect(view.getByText(/Lifecycle\.data\.email_id/)).toBeTruthy();
    expect(view.queryByText(/V1StGXR8_Z5jdHi6B-myT/)).toBeNull();
  });

  it("reads an Event name by its catalog label", () => {
    const eventNameFields: ConditionSelectableField[] = [
      field("$event.name", "Carried by every Event", {
        label: "Event name",
        enumValues: ["resend/email.sent", "resend/email.delivered"],
        enumLabels: {
          "resend/email.sent": "Email sent",
          "resend/email.delivered": "Email delivered",
        },
      }),
    ];
    const view = renderRow(
      eventNameFields,
      stringRule("$event.name", "resend/email.sent")
    );

    expect(view.getByText("Email sent")).toBeTruthy();
    expect(view.queryByText("resend/email.sent")).toBeNull();
  });

  it("does not print a node id in the compiled CEL preview", () => {
    const token = "{{@V1StGXR8_Z5jdHi6B-myT:Lifecycle.data.email_id}}";
    const view = renderRow(
      APPOINTMENT_FIELDS,
      stringRule("appointment.id", token)
    );

    enterEdit(view);

    const compiled = view.getByText(/Compiled CEL/);
    expect(compiled.textContent).toContain("Lifecycle.data.email_id");
    expect(compiled.textContent).not.toContain("V1StGXR8_Z5jdHi6B-myT");
  });
});

/** A stored `is one of` rule on `email`, a string field with no enum values. */
function emailSetModel(values: string[]): string {
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
            field: "email",
            fieldType: "string",
            operator: "is_one_of",
            values,
          },
        ],
      },
    ],
  });
}

// The build agent writes `is one of` on any string field, so a field with no
// enum values needs a list the builder types into. The list itself (adding
// and removing chips) is `TextSetValueInput`'s own suite; this case only
// checks that the row wires a typed value through to the operator and the
// compiled expression it feeds `ConditionSummary`.
describe("ConditionBuilderRow set comparison on a plain string field", () => {
  it("adds a value to a plain string field's set and compiles it", () => {
    const onChange = vi.fn();
    const view = renderRow(
      DONOR_FIELDS,
      emailSetModel(["a@example.com"]),
      onChange
    );

    expect(view.queryByText(/fixed list/)).toBeNull();

    enterEdit(view);
    expect(
      view.getByRole("combobox", { name: "email operator" }).textContent
    ).toContain("is one of");
    expect(view.queryByLabelText("Select email values")).toBeNull();

    const input = view.getByLabelText("Add email values");
    fireEvent.change(input, { target: { value: "c@example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(writtenRule(onChange)).toMatchObject({
      operator: "is_one_of",
      values: ["a@example.com", "c@example.com"],
    });
    expect(onChange.mock.calls.at(-1)?.[0].expression).toContain(
      'payload.email in ["a@example.com", "c@example.com"]'
    );
  });

  it("keeps the enum picker for a field with enum values", () => {
    const withEnum = [
      field("status", "Look Up Donor", { enumValues: ["confirmed", "booked"] }),
    ];
    const view = renderRow(
      withEnum,
      serializeConditionModel({
        version: 2,
        groupLogic: "and",
        groups: [
          {
            id: "g",
            logic: "and",
            conditions: [
              {
                id: "r",
                field: "status",
                fieldType: "string",
                operator: "is_one_of",
                values: ["confirmed"],
              },
            ],
          },
        ],
      })
    );

    enterEdit(view);

    expect(view.getByLabelText("Select status values")).toBeTruthy();
    expect(view.queryByLabelText("Add status values")).toBeNull();
  });

  // Where set comparisons need enum values, a stored one still reads back
  // whole: the operator the rule holds and every value it compares.
  it("shows a stored set rule the restricted builder no longer offers", () => {
    const view = renderRow(
      DONOR_FIELDS,
      emailSetModel(["a@example.com"]),
      undefined,
      { setOperatorsRequireEnumValues: true }
    );

    expect(view.getByText(/no longer offers a fixed list/)).toBeTruthy();

    enterEdit(view);
    expect(
      view.getByRole("combobox", { name: "email operator" }).textContent
    ).toContain("is one of");
    expect(view.getByText("a@example.com")).toBeTruthy();
  });
});

/** A stored `is one of` rule on `status`, a string field with enum values. */
function statusSetModel(values: string[]): string {
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
            field: "status",
            fieldType: "string",
            operator: "is_one_of",
            values,
          },
        ],
      },
    ],
  });
}

const STATUS_FIELDS: ConditionSelectableField[] = [
  field("status", "Lifecycle", { enumValues: ["active", "paused"] }),
];

// `EnumMultiValueInput` has its own suite for picking, keeping, and removing
// operands. This describe block covers only the row's view-mode summary: the
// text it shows for a set rule without opening the editor.
describe("ConditionBuilderRow set comparison on an enum field", () => {
  const reference = "{{@entry:Lifecycle.email}}";

  // A reference is resolved when the run reaches the rule, so the summary has
  // no enum value to hold it to.
  it("reports no refusal in view mode for a set holding a reference", () => {
    const view = renderRow(
      STATUS_FIELDS,
      statusSetModel(["active", reference])
    );

    expect(view.getByText(/Lifecycle\.email/)).toBeTruthy();
    expect(view.queryByText(/no longer offers/)).toBeNull();
  });

  it("still reports a literal the field no longer offers in view mode", () => {
    const view = renderRow(
      STATUS_FIELDS,
      statusSetModel(["active", "cancelled"])
    );

    expect(
      view.getByText(/no longer offers one or more selected values/)
    ).toBeTruthy();
  });

  it("reports no refusal in view mode for equals holding a reference", () => {
    const view = renderRow(
      STATUS_FIELDS,
      serializeConditionModel({
        version: 2,
        groupLogic: "and",
        groups: [
          {
            id: "g",
            logic: "and",
            conditions: [
              {
                id: "r",
                field: "status",
                fieldType: "string",
                operator: "equals",
                value: reference,
              },
            ],
          },
        ],
      })
    );

    expect(view.getByText(/Lifecycle\.email/)).toBeTruthy();
    expect(view.queryByText(/no longer offers/)).toBeNull();
  });
});

/**
 * A model of two groups, each holding one rule, for the cases about what a
 * removal takes with it.
 */
function twoGroups(): string {
  return serializeConditionModel({
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "g1",
        logic: "and",
        conditions: [
          {
            id: "r1",
            field: "appointment.id",
            fieldType: "string",
            operator: "equals",
            value: "a",
          },
        ],
      },
      {
        id: "g2",
        logic: "and",
        conditions: [
          {
            id: "r2",
            field: "appointment.id",
            fieldType: "string",
            operator: "equals",
            value: "b",
          },
        ],
      },
    ],
  });
}

// A configured row used to be permanent: the last rule and the last group both
// refused to go, so nothing returned the row to naming no condition at all.
describe("ConditionBuilderRow removal", () => {
  it("clears the whole condition when the only rule goes", () => {
    const onChange = vi.fn();
    const view = renderRow(
      APPOINTMENT_FIELDS,
      storedModel("appointment.id"),
      onChange
    );

    enterEdit(view);
    fireEvent.click(
      view.getByRole("button", { name: "Remove condition on appointment.id" })
    );

    expect(onChange).toHaveBeenCalledWith({ model: "", expression: "" });
    expect(
      view.getByRole("button", { name: "Configure condition" })
    ).toBeTruthy();
  });

  it("keeps the other rule when one of two goes", () => {
    const onChange = vi.fn();
    const view = renderRow(APPOINTMENT_FIELDS, twoGroups(), onChange);

    enterEdit(view);
    fireEvent.click(
      view.getAllByRole("button", { name: /^Remove condition on / })[0]
    );

    const written = parseConditionModel(onChange.mock.calls.at(-1)?.[0].model);
    expect(written.valid).toBe(true);
    expect(written.valid && written.model.groups).toHaveLength(1);
    expect(written.valid && written.model.groups[0].conditions[0].id).toBe(
      "r2"
    );
  });

  it("keeps the other group when one of two goes", () => {
    const onChange = vi.fn();
    const view = renderRow(APPOINTMENT_FIELDS, twoGroups(), onChange);

    enterEdit(view);
    fireEvent.click(view.getByRole("button", { name: "Remove group 1" }));

    const written = parseConditionModel(onChange.mock.calls.at(-1)?.[0].model);
    expect(written.valid).toBe(true);
    expect(written.valid && written.model.groups).toHaveLength(1);
    expect(written.valid && written.model.groups[0].conditions[0].id).toBe(
      "r2"
    );
  });

  it("keeps a disabled row on its summary, with no removal to reach", () => {
    const view = render(
      <ConditionBuilderRow
        currentNodeId="condition-1"
        defaultEditing
        description="Build a condition"
        disabled
        editActionName="condition"
        emptyFieldsMessage="No fields"
        fields={APPOINTMENT_FIELDS}
        label="Continue when"
        onChange={vi.fn()}
        value={storedModel("appointment.id")}
      />
    );

    // `editable` is the verdict over the mode the caller asked for, so a row
    // nobody may write to reads as its summary and offers no trash to press.
    expect(view.queryAllByRole("button", { name: /^Remove /u })).toEqual([]);
    expect(view.queryAllByRole("button", { name: /^Edit /u })).toEqual([]);
  });
});
