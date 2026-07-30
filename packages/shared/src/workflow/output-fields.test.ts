import { Schema, SchemaTransformation } from "effect";
import { describe, expect, it } from "vitest";
import { outputFieldsFromSchema } from "#src/workflow/output-fields";

describe("outputFieldsFromSchema", () => {
  it("derives a codec field from the encoded side", () => {
    // A codec's decoded side may have no JSON form at all: a Date target
    // renders as {} and the field silently vanishes if the decoded side is
    // asked. The encoded side is what JSONB and memoized outputs hold, so it
    // is the side the editor must describe.
    const schema = Schema.Struct({
      at: Schema.String.annotate({
        description: "When it happened",
        format: "date-time",
      }).pipe(Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString)),
      name: Schema.String.annotate({ description: "Plain string" }),
    });

    const fields = outputFieldsFromSchema(schema);
    const paths = fields.map((field) => field.path);

    expect(paths).toContain("at");
    expect(paths).toContain("name");
    const at = fields.find((field) => field.path === "at");
    expect(at?.type).toBe("timestamp");
    expect(at?.description).toBe("When it happened");
  });
});
