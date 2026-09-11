import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ConditionSelectableField } from "#src/lib/upstream-node-fields";
import {
  EnumMultiValueInput,
  TextSetValueInput,
} from "#src/components/workflow/config/condition-set-value-input";

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

/** A controlled harness holding `values`, the shape both widgets are given by the row. */
function EnumMultiValueHarness({
  field: fieldDef,
  initialValues,
  name,
  onValueChange,
}: {
  field: ConditionSelectableField | undefined;
  initialValues: string[];
  name: string;
  onValueChange: (values: string[]) => void;
}) {
  const [values, setValues] = useState(initialValues);
  return (
    <EnumMultiValueInput
      disabled={false}
      field={fieldDef}
      name={name}
      onValueChange={(next) => {
        setValues(next);
        onValueChange(next);
      }}
      values={values}
    />
  );
}

function TextSetValueHarness({
  initialValues,
  name,
  onValueChange,
}: {
  initialValues: string[];
  name: string;
  onValueChange: (values: string[]) => void;
}) {
  const [values, setValues] = useState(initialValues);
  return (
    <TextSetValueInput
      disabled={false}
      name={name}
      onValueChange={(next) => {
        setValues(next);
        onValueChange(next);
      }}
      values={values}
    />
  );
}

describe("TextSetValueInput", () => {
  it("shows every stored value and edits the list by typing", () => {
    const onValueChange = vi.fn();
    const view = render(
      <TextSetValueHarness
        initialValues={["a@example.com", "b@example.com"]}
        name="email"
        onValueChange={onValueChange}
      />
    );

    expect(view.getByText("a@example.com")).toBeTruthy();
    expect(view.getByText("b@example.com")).toBeTruthy();

    const input = view.getByLabelText("Add email values");
    fireEvent.change(input, { target: { value: "  c@example.com " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
    expect(input).toHaveProperty("value", "");

    fireEvent.click(view.getByRole("button", { name: "Remove b@example.com" }));

    expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual([
      "a@example.com",
      "c@example.com",
    ]);
  });

  it("offers no entry for blank text or a value already listed", () => {
    const onValueChange = vi.fn();
    const view = render(
      <TextSetValueHarness
        initialValues={["a@example.com"]}
        name="email"
        onValueChange={onValueChange}
      />
    );

    const input = view.getByLabelText("Add email values");
    // Open the popup, so a missing Add entry is one the list left out.
    fireEvent.keyDown(input, { key: "ArrowDown" });

    fireEvent.change(input, { target: { value: "   " } });
    expect(view.queryByRole("option", { name: /^Add / })).toBeNull();

    fireEvent.change(input, { target: { value: " a@example.com " } });
    expect(view.queryByRole("option", { name: /^Add / })).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("adds typed text from its Add entry", () => {
    const onValueChange = vi.fn();
    const view = render(
      <TextSetValueHarness
        initialValues={[]}
        name="email"
        onValueChange={onValueChange}
      />
    );

    const input = view.getByLabelText("Add email values");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.change(input, { target: { value: "d@example.com" } });
    fireEvent.click(view.getByRole("option", { name: 'Add "d@example.com"' }));

    expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual(["d@example.com"]);
  });

  it("adds typed text once when Enter picks the highlighted Add entry", () => {
    const onValueChange = vi.fn();
    const view = render(
      <TextSetValueHarness
        initialValues={[]}
        name="email"
        onValueChange={onValueChange}
      />
    );

    const input = view.getByLabelText("Add email values");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.change(input, { target: { value: "e@example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual(["e@example.com"]);
  });
});

describe("EnumMultiValueInput", () => {
  const STATUS_FIELD = field("status", "Lifecycle", {
    enumValues: ["active", "paused"],
  });

  it("labels a chip with the field's enum label", () => {
    const withLabels = field("status", "Lifecycle", {
      enumValues: ["confirmed", "booked"],
      enumLabels: { confirmed: "Confirmed", booked: "Booked" },
    });
    const view = render(
      <EnumMultiValueHarness
        field={withLabels}
        initialValues={["confirmed"]}
        name="status"
        onValueChange={vi.fn()}
      />
    );

    expect(view.getByText("Confirmed")).toBeTruthy();
    expect(view.queryByText("confirmed")).toBeNull();
  });

  // The build agent's `set_wait` tool accepts a set that mixes enum literals
  // with a template reference, so the picker holds every operand it does not
  // offer until the builder removes that operand's chip.
  it("keeps a template reference while enum values are picked and removed", () => {
    const reference = "{{@entry:Lifecycle.email}}";
    const onValueChange = vi.fn();
    const view = render(
      <EnumMultiValueHarness
        field={STATUS_FIELD}
        initialValues={["active", reference]}
        name="status"
        onValueChange={onValueChange}
      />
    );

    expect(view.getByText("active")).toBeTruthy();
    expect(view.getByText("Lifecycle.email")).toBeTruthy();
    expect(view.queryByText(/\{\{@/)).toBeNull();

    const values = view.getByLabelText("Select status values");
    fireEvent.keyDown(values, { key: "ArrowDown" });
    // The popup offers the field's enum values alone.
    expect(
      view.getAllByRole("option").map((option) => option.textContent)
    ).toEqual(["active", "paused"]);
    fireEvent.click(view.getByRole("option", { name: "paused" }));
    fireEvent.keyDown(values, { key: "Escape" });

    expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual([
      "active",
      reference,
      "paused",
    ]);

    fireEvent.click(view.getByRole("button", { name: "Remove active" }));
    expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual([reference, "paused"]);

    fireEvent.click(
      view.getByRole("button", { name: "Remove Lifecycle.email" })
    );
    expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual(["paused"]);
  });

  it("keeps a literal the field no longer offers until its chip is removed", () => {
    const onValueChange = vi.fn();
    const view = render(
      <EnumMultiValueHarness
        field={STATUS_FIELD}
        initialValues={["active", "cancelled"]}
        name="status"
        onValueChange={onValueChange}
      />
    );

    expect(view.getByText("cancelled")).toBeTruthy();

    const values = view.getByLabelText("Select status values");
    fireEvent.keyDown(values, { key: "ArrowDown" });
    fireEvent.click(view.getByRole("option", { name: "paused" }));
    fireEvent.keyDown(values, { key: "Escape" });

    expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual([
      "active",
      "cancelled",
      "paused",
    ]);

    fireEvent.click(view.getByRole("button", { name: "Remove active" }));
    expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual([
      "cancelled",
      "paused",
    ]);

    fireEvent.click(view.getByRole("button", { name: "Remove cancelled" }));
    expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual(["paused"]);
  });
});
