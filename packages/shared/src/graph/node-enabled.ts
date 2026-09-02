/**
 * A node is on unless `enabled` is `false`. A `true`, a present `undefined` and
 * a missing key are all the same state, so persist, the publication diff, and
 * editor writes drop the key in every one of them.
 */

export function persistedNodeEnabled(
  enabled: boolean | undefined
): false | undefined {
  return enabled === false ? false : undefined;
}

export function canonicalizeNodeEnabled<
  T extends { enabled?: boolean | undefined },
>(data: T): T {
  if (data.enabled === false || !Object.hasOwn(data, "enabled")) {
    return data;
  }
  const copy = { ...data };
  delete copy.enabled;
  return copy;
}
