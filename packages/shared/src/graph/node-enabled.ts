/**
 * A node is on unless `enabled` is `false`. `true` and a missing key are the
 * same state, so persist, the publication diff, and editor writes drop `true`.
 */

export function persistedNodeEnabled(
  enabled: boolean | undefined
): false | undefined {
  return enabled === false ? false : undefined;
}

export function canonicalizeNodeEnabled<T extends { enabled?: boolean }>(
  data: T
): T {
  if (data.enabled !== true) {
    return data;
  }
  const { enabled: _enabled, ...rest } = data;
  return rest as T;
}
