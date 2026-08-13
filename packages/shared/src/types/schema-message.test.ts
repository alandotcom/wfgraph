import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { NonEmptyTrimmedString } from "#src/types/schema";
import { formatSchemaFailure } from "#src/types/schema-message";

describe("formatSchemaFailure", () => {
  // Effect's Standard Schema formatter handles a no-match union past the leaf
  // hook, where its own label spells out every arm. A long secret-looking string
  // in that object is the acceptance case: the rendered message must stay short
  // and must hold nothing of what arrived.
  it("keeps a non-matching union's value out of the message", () => {
    const union = Schema.Union([
      Schema.Struct({ type: Schema.Literal("a"), x: Schema.Number }),
      Schema.Struct({ type: Schema.Literal("b"), y: Schema.String }),
    ]);
    const secret = `sk-live-${"x".repeat(80)}`;
    const result = Schema.decodeUnknownResult(union)({
      type: "c",
      token: secret,
    });

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) {
      return;
    }

    const message = formatSchemaFailure(result.failure.issue);

    expect(message).not.toContain(secret);
    expect(message).not.toContain("sk-live-");
    expect(message.length).toBeLessThan(120);
    expect(message).toBe("<root>: Expected an object");
  });

  it("still honours a message annotation on a no-match union", () => {
    const union = Schema.Union([
      Schema.Struct({ type: Schema.Literal("a") }),
      Schema.Struct({ type: Schema.Literal("b") }),
    ]).annotate({ message: "Needs type a or b" });
    const result = Schema.decodeUnknownResult(union)({
      type: "c",
      secret: "sk-live-do-not-echo-this",
    });

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) {
      return;
    }

    const message = formatSchemaFailure(result.failure.issue);

    expect(message).not.toContain("sk-live-do-not-echo-this");
    expect(message).toBe("<root>: Needs type a or b");
  });

  // A rejected field names its path and what was expected of it. Effect retains
  // the value only under `reportInput`, which no decode in this project passes,
  // so there is nothing of the input left for a message to carry.
  it("names the path and the expectation for a rejected field", () => {
    const result = Schema.decodeUnknownResult(
      Schema.Struct({ email: Schema.String }),
      { errors: "all" }
    )({ email: { token: "sk-live-do-not-echo-this" } });

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) {
      return;
    }

    const message = formatSchemaFailure(result.failure.issue);

    expect(message).not.toContain("sk-live-do-not-echo-this");
    expect(message).toBe("email: Expected string");
  });

  // A failed check keeps the bound Effect wanted. Overriding the check hook to
  // say one flat word costs every `NonEmptyTrimmedString` in the repo its
  // sentence, and nothing about the bound discloses the value that missed it.
  it("keeps the bound a failed check names", () => {
    const result = Schema.decodeResult(
      Schema.Struct({ name: NonEmptyTrimmedString }),
      { errors: "all" }
    )({ name: "" });

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) {
      return;
    }

    expect(formatSchemaFailure(result.failure.issue)).toBe(
      "name: Expected a value with a length of at least 1"
    );
  });

  // The summary spells out the first few and counts the rest, which is what
  // keeps a wide struct's refusal to one line.
  it("counts the issues past the third", () => {
    const result = Schema.decodeUnknownResult(
      Schema.Struct({
        a: Schema.String,
        b: Schema.String,
        c: Schema.String,
        d: Schema.String,
        e: Schema.String,
      }),
      { errors: "all" }
    )({});

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) {
      return;
    }

    expect(formatSchemaFailure(result.failure.issue)).toBe(
      "a: Missing key; b: Missing key; c: Missing key; ... (+2 more)"
    );
  });
});
