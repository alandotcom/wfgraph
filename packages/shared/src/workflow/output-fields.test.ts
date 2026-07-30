import { Schema, SchemaTransformation } from "effect";
import { describe, expect, it } from "vitest";
import { dateField } from "#src/types/timestamp";
import {
  outputFieldsFromSchema,
  requireOutputFieldsFromSchema,
} from "#src/workflow/output-fields";

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
      }).pipe(
        Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString)
      ),
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

describe("requireOutputFieldsFromSchema and the codec hint", () => {
  // The refusal an author meets when a field carries no description the derivation
  // can read. Both shapes below are annotated as far as their author is concerned,
  // which is why the message has to name the reason rather than repeat the demand.
  const CODEC_HINT = "A codec's own annotations do not reach its JSON Schema";

  it("refuses a bare Schema.Date and names the spelling that works", () => {
    expect(() =>
      requireOutputFieldsFromSchema(
        'Action "test/dated"',
        Schema.Struct({ at: Schema.Date })
      )
    ).toThrow(/use `dateField` instead/);
  });

  it("refuses an annotated codec with the same hint", () => {
    // The case the hint was written for: `.annotate()` on a transformation lands
    // on its decoded side, and the derivation compiles the encoded one, so the
    // description never arrives and the author is told they wrote none.
    expect(() =>
      requireOutputFieldsFromSchema(
        'Action "test/dated"',
        Schema.Struct({
          at: Schema.String.pipe(
            Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString)
          ).annotate({ description: "When it happened" }),
        })
      )
    ).toThrow(CODEC_HINT);
  });

  it("accepts the same field written with dateField", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Action "test/dated"',
        Schema.Struct({ at: dateField("When it happened") })
      )
    ).toEqual([
      {
        path: "at",
        description: "When it happened",
        type: "timestamp",
        format: "timestamp",
      },
    ]);
  });
});
