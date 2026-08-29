import { describe, expect, it } from "vitest";
import { RESERVED_RECORD_KEYS } from "../types/record-key";
import { readProviderFieldValues } from "./provider-field-values";

describe("readProviderFieldValues", () => {
  it.each(RESERVED_RECORD_KEYS)("rejects the reserved key %s", (key) => {
    expect(
      readProviderFieldValues(JSON.stringify(Object.fromEntries([[key, "x"]])))
    ).toBeNull();
  });
});
