import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  formatSchemaFailure,
  formatSchemaFailurePaths,
} from "#src/types/schema-message";

describe("formatSchemaFailure", () => {
  // Effect's Standard Schema formatter quotes a no-match union's `actual` in
  // full, past the leaf hook. A long secret-looking string in that object is
  // the acceptance case for closing that hole: the rendered message must stay
  // short and must not contain the string.
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
    expect(message).toBe("<root>: Expected an object, got an object");
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

  it("leaves values out of the paths-only summary for a no-match union", () => {
    const union = Schema.Union([
      Schema.Struct({ type: Schema.Literal("a") }),
      Schema.Struct({ type: Schema.Literal("b") }),
    ]);
    const result = Schema.decodeUnknownResult(union)({
      type: "c",
      secret: "sk-live-do-not-echo-this",
    });

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) {
      return;
    }

    const message = formatSchemaFailurePaths(result.failure.issue);

    expect(message).not.toContain("sk-live-do-not-echo-this");
    expect(message).toBe("<root>: Expected an object");
  });
});
