/** Keys that JavaScript object prototypes give behavior beyond ordinary data. */
export const RESERVED_RECORD_KEYS = [
  "__proto__",
  "prototype",
  "constructor",
] as const;

const reservedRecordKeys = new Set<string>(RESERVED_RECORD_KEYS);

/** Whether a product identifier is safe to use as a key in a data record. */
export function isSafeRecordKey(key: string): boolean {
  return !reservedRecordKeys.has(key);
}

/** Whether every own enumerable key in a data record is safe. */
export function hasOnlySafeRecordKeys(record: object): boolean {
  return Object.keys(record).every(isSafeRecordKey);
}

/** Whether every meaningful segment of a dot-separated object path is safe. */
export function isSafeRecordPath(path: string): boolean {
  return path
    .trim()
    .split(".")
    .filter((segment) => segment.length > 0)
    .every(isSafeRecordKey);
}
