import { describe, expect, it } from "vitest";
import {
  hasOnlySafeRecordKeys,
  isSafeRecordKey,
  isSafeRecordPath,
  RESERVED_RECORD_KEYS,
} from "./record-key";

describe("isSafeRecordKey", () => {
  it.each(RESERVED_RECORD_KEYS)("rejects the reserved key %s", (key) => {
    expect(isSafeRecordKey(key)).toBe(false);
  });

  it("accepts an ordinary record key", () => {
    expect(isSafeRecordKey("templateId")).toBe(true);
  });
});

describe("hasOnlySafeRecordKeys", () => {
  it.each(RESERVED_RECORD_KEYS)("rejects an own %s key", (key) => {
    expect(hasOnlySafeRecordKeys(Object.fromEntries([[key, true]]))).toBe(
      false
    );
  });

  it("accepts ordinary data keys", () => {
    expect(hasOnlySafeRecordKeys({ templateId: "template_1" })).toBe(true);
  });
});

describe("isSafeRecordPath", () => {
  it.each(RESERVED_RECORD_KEYS)("rejects %s as a path segment", (key) => {
    expect(isSafeRecordPath(`event.${key}.value`)).toBe(false);
  });

  it("accepts an ordinary nested path", () => {
    expect(isSafeRecordPath("event.account.id")).toBe(true);
  });
});
