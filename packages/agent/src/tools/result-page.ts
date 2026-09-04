import { Schema } from "effect";

export const DEFAULT_RESULT_LIMIT = 20;
export const MAX_RESULT_LIMIT = 50;

export const resultOffsetSchema = Schema.Number.annotate({
  description: "Zero-based result offset for the next page.",
}).check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

export const resultLimitSchema = Schema.Number.annotate({
  description: `Maximum results to return, from 1 through ${MAX_RESULT_LIMIT}. Defaults to ${DEFAULT_RESULT_LIMIT}.`,
}).check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: MAX_RESULT_LIMIT })
);

function wholeNumberAtLeast(
  value: number | undefined,
  minimum: number
): number {
  return value === undefined || !Number.isFinite(value)
    ? minimum
    : Math.max(minimum, Math.floor(value));
}

export function resultLimit(value: number | undefined): number {
  return value === undefined
    ? DEFAULT_RESULT_LIMIT
    : Math.min(MAX_RESULT_LIMIT, wholeNumberAtLeast(value, 1));
}

export function resultOffset(value: number | undefined): number {
  return wholeNumberAtLeast(value, 0);
}

export function pageResults<T>(
  values: readonly T[],
  input: {
    readonly offset?: number | undefined;
    readonly limit?: number | undefined;
  }
): {
  readonly items: T[];
  readonly total: number;
  readonly nextOffset?: number | undefined;
} {
  const offset = resultOffset(input.offset);
  const limit = resultLimit(input.limit);
  const items = values.slice(offset, offset + limit);
  const nextOffset = offset + items.length;

  return {
    items,
    total: values.length,
    ...(nextOffset < values.length ? { nextOffset } : {}),
  };
}
