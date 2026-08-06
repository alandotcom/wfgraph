import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import { durationString } from "#src/types/duration";
import { requireOutputFieldsFromSchema } from "#src/graph/output-fields";

describe("durationString", () => {
  it("derives a duration field", () => {
    expect(
      requireOutputFieldsFromSchema(
        "x",
        Schema.Struct({ leadTime: durationString("How long before") })
      )
    ).toEqual([
      {
        path: "leadTime",
        description: "How long before",
        type: "duration",
      },
    ]);
  });

  it("refuses text that is not a duration", () => {
    const decode = Schema.decodeUnknownResult(durationString());
    expect(Result.isSuccess(decode("24h"))).toBe(true);
    expect(Result.isSuccess(decode("P1D"))).toBe(true);
    expect(Result.isFailure(decode("Jane Doe"))).toBe(true);
  });
});
