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
}: {
  fields: ConditionSelectableField[];
  initialValue: string;
  onChange?:
    | ((next: { model: string; expression: string }) => void)
    | undefined;
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
