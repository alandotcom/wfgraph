import { describe, expect, it } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import {
  SchemaBuilder,
  type SchemaField,
} from "#src/components/workflow/config/schema-builder";

const FIELD_DETAILS_BUTTON_REGEX = /field details/i;
const NOOP = () => undefined;

function ControlledSchemaBuilder({
  initialSchema,
  onSchemaChange,
}: {
  initialSchema: SchemaField[];
  onSchemaChange?: (schema: SchemaField[]) => void;
}) {
  const [schema, setSchema] = useState<SchemaField[]>(initialSchema);

  return (
    <SchemaBuilder
      onChange={(nextSchema) => {
        setSchema(nextSchema);
        onSchemaChange?.(nextSchema);
      }}
      schema={schema}
    />
  );
}

describe("SchemaBuilder", () => {
  it("adds a new property from empty state", async () => {
    let latestSchema: SchemaField[] = [];

    const view = render(
      <ControlledSchemaBuilder
        initialSchema={[]}
        onSchemaChange={(nextSchema) => {
          latestSchema = nextSchema;
        }}
      />
    );

    expect(view.getByText("No properties defined yet.")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Add Property" }));

    await waitFor(() => {
      expect(latestSchema.length).toBe(1);
      expect(latestSchema[0]?.name).toBe("property");
      expect(latestSchema[0]?.type).toBe("string");
    });
  });

  it("toggles string details visibility", () => {
    const view = render(
      <SchemaBuilder
        onChange={NOOP}
        schema={[{ id: "event", name: "event", type: "string" }]}
      />
    );

    const detailsButton = view.getByRole("button", {
      name: FIELD_DETAILS_BUTTON_REGEX,
    });
    const initiallyExpanded = detailsButton
      .getAttribute("aria-label")
      ?.includes("Hide");

    fireEvent.click(detailsButton);

    const nextLabel = detailsButton.getAttribute("aria-label");
    expect(nextLabel?.includes("Hide")).toBe(!initiallyExpanded);
  });

  it("shows nested object properties by default", () => {
    const view = render(
      <ControlledSchemaBuilder
        initialSchema={[
          {
            id: "data",
            name: "data",
            type: "object",
            fields: [{ name: "id", type: "string" }],
          },
        ]}
      />
    );

    expect(view.getByText("Object Properties")).toBeTruthy();
    expect(view.getByDisplayValue("id")).toBeTruthy();
  });

  it("removes a property row", async () => {
    let latestSchema: SchemaField[] = [
      { id: "event", name: "event", type: "string" },
      { id: "timestamp", name: "timestamp", type: "string" },
    ];

    const view = render(
      <ControlledSchemaBuilder
        initialSchema={latestSchema}
        onSchemaChange={(nextSchema) => {
          latestSchema = nextSchema;
        }}
      />
    );

    const deleteButtons = view.getAllByRole("button", {
      name: "Delete property",
    });

    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(latestSchema.length).toBe(1);
      expect(latestSchema[0]?.name).toBe("timestamp");
    });
  });
});
