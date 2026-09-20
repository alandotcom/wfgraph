import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { type } from "arktype";
import { z } from "zod";
import { requireOutputFieldsFromSchema } from "#src/graph/output-fields";
import { toStandardSchema } from "#src/types/schema";
import { parseWorkflowSchemaFieldsOrJsonSchema } from "./schema-codec";

/**
 * What an Effect schema describes itself as, once it has crossed the bridge.
 * These reach for `toStandardSchema` directly, because what they assert is the
 * JSON Schema Effect derives rather than what a caller does with it.
 */
describe("the field derivation over Effect schemas", () => {
  it("surfaces a hand-annotated Effect string as a described timestamp", () => {
    // Effect derives no `format` for any of its date schemas, so an Effect author
    // writes the keyword themselves. It goes on the base type, before any check:
    // annotations on a checked schema land on the check, which renders under
    // `allOf`, and the derivation reads the flat property.
    const schema = toStandardSchema(
      Schema.Struct({
        createdAt: Schema.String.annotate({
          description: "When it was created",
          format: "date-time",
        }).check(Schema.isPattern(/Z$/)),
      })
    );
    const jsonSchema = schema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    });

    expect(parseWorkflowSchemaFieldsOrJsonSchema(jsonSchema)).toEqual([
      {
        name: "createdAt",
        type: "timestamp",
        description: "When it was created",
      },
    ]);
  });

  it("reads the keyword through Effect's own optional rendering", () => {
    // `Schema.optional` renders as `anyOf: [T, null]`, so the keyword sits on a
    // member rather than on the property. Deriving from the schema itself is the
    // point: the hand-written document beside this one would keep passing if
    // Effect moved where it puts the keyword.
    expect(
      requireOutputFieldsFromSchema(
        "Probe",
        Schema.Struct({
          startsAt: Schema.optional(
            Schema.String.annotate({
              description: "When it starts",
              format: "date-time",
            })
          ),
        })
      )
    ).toEqual([
      {
        path: "startsAt",
        description: "When it starts",
        type: "timestamp",
        nullable: true,
      },
    ]);
  });

  it("looks through allOf for the keyword a check contributed", () => {
    // A schema library is free to hang the keyword one level down, and Effect
    // hangs everything a `.check(...)` contributed there. The walk into `allOf`
    // is what keeps such a document readable.
    expect(
      parseWorkflowSchemaFieldsOrJsonSchema({
        type: "object",
        required: ["createdAt"],
        properties: {
          createdAt: {
            type: "string",
            description: "When it was created",
            allOf: [{ format: "date-time" }],
          },
        },
      })
    ).toEqual([
      {
        name: "createdAt",
        type: "timestamp",
        description: "When it was created",
      },
    ]);
  });

  it("leaves an Effect date morph as a plain string", () => {
    // Not an `allOf` problem: Effect derives neither `format` nor `pattern` for
    // `DateFromString`, so its JSON Schema is a bare `{ type: "string" }` and
    // there is no keyword anywhere in it to recognise. An Effect schema that
    // wants its dates read as timestamps has to carry the pattern itself, as
    // the case above does.
    const schema = toStandardSchema(
      Schema.Struct({ createdAt: Schema.DateFromString })
    );
    const jsonSchema = schema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    });

    expect(parseWorkflowSchemaFieldsOrJsonSchema(jsonSchema)).toEqual([
      { name: "createdAt", type: "string", description: undefined },
    ]);
  });

  it("derives Schema.Literals as a closed string set", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Event "x/y"',
        Schema.Struct({ a: Schema.Literals(["X", "Y"]) })
      )
    ).toEqual([{ path: "a", type: "string", enumValues: ["X", "Y"] }]);
  });

  it("derives Schema.Enum as a closed string set", () => {
    // Effect renders each member as its own `{ type, enum: [one] }` under
    // `anyOf`, not as one `enum` array. The reader has to join those branches.
    expect(
      requireOutputFieldsFromSchema(
        'Event "x/y"',
        Schema.Struct({ a: Schema.Enum({ X: "X", Y: "Y" }) })
      )
    ).toEqual([{ path: "a", type: "string", enumValues: ["X", "Y"] }]);
  });

  it("derives Effect enum member titles as labels", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Event "x/y"',
        Schema.Struct({
          status: Schema.Enum({
            "In progress": "InProgress",
            "Needs review": "NeedsReview",
          }).annotate({ title: "Task status" }),
        })
      )
    ).toEqual([
      {
        path: "status",
        label: "Task status",
        type: "string",
        enumValues: ["InProgress", "NeedsReview"],
        enumLabels: {
          InProgress: "In progress",
          NeedsReview: "Needs review",
        },
      },
    ]);
  });

  it("keeps a nullable singleton literal's checked timestamp format", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Event "x/y"',
        Schema.Struct({
          at: Schema.NullOr(
            Schema.Literal("2026-01-01T00:00:00Z")
              .check(Schema.isPattern(/Z$/))
              .annotate({ format: "date-time" })
          ),
        })
      )
    ).toEqual([
      {
        path: "at",
        type: "timestamp",
        enumValues: ["2026-01-01T00:00:00Z"],
        nullable: true,
      },
    ]);
  });

  it("keeps a described Schema.Enum non-nullable", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Event "x/y"',
        Schema.Struct({
          a: Schema.Enum({ X: "X", Y: "Y" }).annotate({ description: "A" }),
        })
      )
    ).toEqual([
      {
        path: "a",
        description: "A",
        type: "string",
        enumValues: ["X", "Y"],
      },
    ]);
  });

  it("marks NullOr Literals nullable and keeps the closed set", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Event "x/y"',
        Schema.Struct({ a: Schema.NullOr(Schema.Literals(["X", "Y"])) })
      )
    ).toEqual([
      {
        path: "a",
        type: "string",
        enumValues: ["X", "Y"],
        nullable: true,
      },
    ]);
  });

  it("marks NullOr Enum nullable and keeps the closed set", () => {
    // `NullOr` wraps the enum `anyOf` in another `anyOf` with `{ type: "null" }`.
    expect(
      requireOutputFieldsFromSchema(
        'Event "x/y"',
        Schema.Struct({ a: Schema.NullOr(Schema.Enum({ X: "X", Y: "Y" })) })
      )
    ).toEqual([
      {
        path: "a",
        type: "string",
        enumValues: ["X", "Y"],
        nullable: true,
      },
    ]);
  });

  it("derives a UUID check as a non-nullable string", () => {
    // Effect has no `Schema.UUID`. The check hangs `format: "uuid"` under
    // `allOf`; uuid is not timestamp/duration, so the field is a string.
    expect(
      requireOutputFieldsFromSchema(
        'Event "x/y"',
        Schema.Struct({ a: Schema.String.check(Schema.isUUID()) })
      )
    ).toEqual([{ path: "a", type: "string" }]);
  });
});

/**
 * arktype renders closed string sets as a bare `enum` with no `type`, and
 * `string.uuid` as a pattern branch plus two const UUIDs. The derivation has
 * to keep those fields, and a described union must not pick up `nullable`.
 */
describe("the field derivation over arktype schemas", () => {
  it("derives a plain string", () => {
    expect(
      requireOutputFieldsFromSchema('Event "x/y"', type({ a: "string" }))
    ).toEqual([{ path: "a", type: "string" }]);
  });

  it("derives string.uuid as a non-nullable string", () => {
    expect(
      requireOutputFieldsFromSchema('Event "x/y"', type({ a: "string.uuid" }))
    ).toEqual([{ path: "a", description: "a UUID", type: "string" }]);
  });

  it("derives a literal union as a closed string set", () => {
    expect(
      requireOutputFieldsFromSchema('Event "x/y"', type({ a: '"X" | "Y"' }))
    ).toEqual([{ path: "a", type: "string", enumValues: ["X", "Y"] }]);
  });

  it("derives type.enumerated as a closed string set", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Event "x/y"',
        type({ a: type.enumerated("X", "Y") })
      )
    ).toEqual([{ path: "a", type: "string", enumValues: ["X", "Y"] }]);
  });

  it("keeps a described literal union non-nullable", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Event "x/y"',
        type({ a: type('"X" | "Y"').describe("A") })
      )
    ).toEqual([
      {
        path: "a",
        description: "A",
        type: "string",
        enumValues: ["X", "Y"],
      },
    ]);
  });

  it("keeps a described enumeration non-nullable", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Event "x/y"',
        type({ a: type.enumerated("X", "Y").describe("A") })
      )
    ).toEqual([
      {
        path: "a",
        description: "A",
        type: "string",
        enumValues: ["X", "Y"],
      },
    ]);
  });

  it("marks children of a nullable object and of an array index as nullable", () => {
    const child = type({ uuid: "string", date: "string" });

    expect(
      requireOutputFieldsFromSchema(
        'Action "x/y"',
        type({
          nested: child.or(type("null")),
          list: child.array(),
          scalar: "string | null",
        })
      )
    ).toEqual([
      { path: "list", type: "array" },
      { path: "list[0].date", type: "string", nullable: true },
      { path: "list[0].uuid", type: "string", nullable: true },
      { path: "nested", type: "object", nullable: true },
      { path: "nested.date", type: "string", nullable: true },
      { path: "nested.uuid", type: "string", nullable: true },
      { path: "scalar", type: "string", nullable: true },
    ]);
  });
});

/**
 * Zod puts `type` on enums and uuids, so those already survived. A literal
 * union is `anyOf` of typed consts with no null branch: that must stay a
 * closed set, and `.describe` must not mark it nullable.
 */
describe("the field derivation over Zod schemas", () => {
  it("derives a plain string", () => {
    expect(
      requireOutputFieldsFromSchema('Event "x/y"', z.object({ a: z.string() }))
    ).toEqual([{ path: "a", type: "string" }]);
  });

  it("derives z.uuid as a non-nullable string", () => {
    expect(
      requireOutputFieldsFromSchema('Event "x/y"', z.object({ a: z.uuid() }))
    ).toEqual([{ path: "a", type: "string" }]);
  });

  it("derives z.enum as a closed string set", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Event "x/y"',
        z.object({ a: z.enum(["X", "Y"]) })
      )
    ).toEqual([{ path: "a", type: "string", enumValues: ["X", "Y"] }]);
  });

  it("derives a literal union as a closed string set", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Event "x/y"',
        z.object({ a: z.union([z.literal("X"), z.literal("Y")]) })
      )
    ).toEqual([{ path: "a", type: "string", enumValues: ["X", "Y"] }]);
  });

  it("derives Zod literal titles as enum labels", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Event "x/y"',
        z.object({
          kind: z
            .union([
              z
                .literal("appointmentReminders")
                .meta({ title: "Appointment reminders" }),
              z.literal("followUp").meta({ title: "Follow-up" }),
            ])
            .meta({ title: "Kind" }),
        })
      )
    ).toEqual([
      {
        path: "kind",
        label: "Kind",
        type: "string",
        enumValues: ["appointmentReminders", "followUp"],
        enumLabels: {
          appointmentReminders: "Appointment reminders",
          followUp: "Follow-up",
        },
      },
    ]);
  });

  it("keeps a described enum non-nullable", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Event "x/y"',
        z.object({ a: z.enum(["X", "Y"]).describe("A") })
      )
    ).toEqual([
      {
        path: "a",
        description: "A",
        type: "string",
        enumValues: ["X", "Y"],
      },
    ]);
  });

  it("keeps a described literal union non-nullable", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Event "x/y"',
        z.object({
          a: z.union([z.literal("X"), z.literal("Y")]).describe("A"),
        })
      )
    ).toEqual([
      {
        path: "a",
        description: "A",
        type: "string",
        enumValues: ["X", "Y"],
      },
    ]);
  });

  it("marks a nullable enum nullable and keeps the closed set", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Event "x/y"',
        z.object({ a: z.enum(["X", "Y"]).nullable() })
      )
    ).toEqual([
      {
        path: "a",
        type: "string",
        enumValues: ["X", "Y"],
        nullable: true,
      },
    ]);
  });
});
