import { Schema, SchemaTransformation } from "effect";
import { describe, expect, it } from "vitest";
import type { StandardSchema } from "#src/types/schema";
import {
  outputFieldsFromSchema,
  requireOutputFieldsFromSchema,
} from "#src/graph/output-fields";

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

/**
 * A Standard Schema answering one fixed JSON Schema document, or refusing to
 * describe itself at all.
 *
 * The two refusals it covers below are documents no Effect schema produces, and
 * the derivation meets both from a foreign library.
 */
function describingItselfAs(
  document: Record<string, unknown> | "nothing"
): StandardSchema<unknown> {
  const answer = () => {
    if (document === "nothing") {
      throw new Error("this library publishes no JSON Schema");
    }
    return document;
  };

  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: answer, output: answer },
    },
  };
}

describe("requireOutputFieldsFromSchema", () => {
  it("derives a schema that annotates nothing, describing no key", () => {
    // Validation is the author's job and presentation is Rova's, so a schema
    // written in any library derives without being edited to serve the editor.
    // An author who wrote no description gets none, and each surface decides
    // what to show in its place.
    expect(
      requireOutputFieldsFromSchema(
        'Action "test/plain"',
        Schema.Struct({
          appointmentId: Schema.String,
          attendeeCount: Schema.Finite,
        })
      )
    ).toStrictEqual([
      { path: "appointmentId", type: "string" },
      { path: "attendeeCount", type: "number" },
    ]);
  });

  it("derives a bare Schema.Date as an undescribed string", () => {
    // Effect publishes no `format: "date-time"` for either of its date schemas,
    // so the field arrives as the plain string the encoded side holds. Any
    // library that does publish the keyword is read as a timestamp.
    expect(
      requireOutputFieldsFromSchema(
        'Action "test/dated"',
        Schema.Struct({ cancelledAt: Schema.Date })
      )
    ).toEqual([{ path: "cancelledAt", type: "string" }]);
  });

  it("reads a codec's encoded annotation and not its decoded one", () => {
    // `.annotate()` on a transformation lands on its decoded side, which the
    // derivation never compiles, so only the encoded description arrives.
    expect(
      requireOutputFieldsFromSchema(
        'Action "test/dated"',
        Schema.Struct({
          startsAt: Schema.String.annotate({
            description: "When it starts",
            format: "date-time",
          }).pipe(
            Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString)
          ),
          endsAt: Schema.String.pipe(
            Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString)
          ).annotate({ description: "When it ends" }),
        })
      )
    ).toEqual([
      {
        path: "startsAt",
        description: "When it starts",
        type: "timestamp",
        format: "timestamp",
      },
      { path: "endsAt", type: "string" },
    ]);
  });

  it("refuses a root that is not an object with named properties", () => {
    expect(() =>
      requireOutputFieldsFromSchema(
        'Action "test/listed"',
        Schema.Array(Schema.String)
      )
    ).toThrow(/its root is not an object with named properties/);
  });

  it("refuses a property the derivation could not read, naming it", () => {
    // `Schema.Number` admits NaN and the two infinities, which JSON Schema
    // cannot express, so Effect describes it as a union of a number and three
    // string literals and the reader keeps no field. `Schema.Finite` is the
    // spelling that survives.
    expect(() =>
      requireOutputFieldsFromSchema(
        'Action "test/counted"',
        Schema.Struct({ attendeeCount: Schema.Number })
      )
    ).toThrow(/attendeeCount did not survive the derivation/);
  });

  it("refuses an object that declares no properties", () => {
    expect(() =>
      requireOutputFieldsFromSchema(
        'Event "app/empty"',
        describingItselfAs({ type: "object", properties: {} })
      )
    ).toThrow(/declares no properties/);
  });

  it("refuses a schema that describes itself as no JSON Schema at all", () => {
    expect(() =>
      requireOutputFieldsFromSchema(
        'Event "app/opaque"',
        describingItselfAs("nothing")
      )
    ).toThrow(/neither an output nor an input JSON Schema/);
  });
});
