import { describe, expect, it } from "vitest";
import {
  DatabaseError,
  hasDatabaseErrorCode,
} from "#src/backend/lib/effect/database";

describe("hasDatabaseErrorCode", () => {
  it("reads a code the driver put on the first link", () => {
    const error = new DatabaseError({ cause: { code: "40001" } });

    expect(hasDatabaseErrorCode(error, "40001")).toBe(true);
    expect(hasDatabaseErrorCode(error, "23505")).toBe(false);
  });

  // What a real driver raises is nested: Drizzle wraps the failure in a
  // `DrizzleQueryError` carrying the SQL it ran, so the code sits one level
  // further down.
  it("reads a code under a driver wrapper", () => {
    const error = new DatabaseError({
      cause: { query: "insert into ...", cause: { code: "40001" } },
    });

    expect(hasDatabaseErrorCode(error, "40001")).toBe(true);
  });

  it("answers false rather than spinning on a cause that points at itself", () => {
    const cyclic: { code: string; cause?: unknown } = { code: "23505" };
    cyclic.cause = cyclic;

    expect(
      hasDatabaseErrorCode(new DatabaseError({ cause: cyclic }), "40001")
    ).toBe(false);
  });

  it("answers false for a cause carrying no code at any depth", () => {
    expect(
      hasDatabaseErrorCode(new DatabaseError({ cause: "a string" }), "40001")
    ).toBe(false);
    expect(
      hasDatabaseErrorCode(
        new DatabaseError({ cause: { cause: null } }),
        "40001"
      )
    ).toBe(false);
  });
});
