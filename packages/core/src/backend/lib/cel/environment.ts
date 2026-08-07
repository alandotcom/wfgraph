import { Environment } from "@marcbachmann/cel-js";
import { decodeIsoTimestamp } from "@wfgraph/shared/types/timestamp";

const TIMESTAMP_TYPE = "google.protobuf.Timestamp";
const DURATION_TYPE = "google.protobuf.Duration";
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BIGINT_7 = BigInt(7);
const BIGINT_24 = BigInt(24);
const BIGINT_60 = BigInt(60);

type DurationFactory = (seconds: bigint | number, nanos?: number) => unknown;
type ParsedExpression = (context?: unknown) => unknown;

export type CelValidationResult = { ok: true } | { ok: false; error: string };

export type CelEvaluationResult =
  | { ok: true; value: boolean }
  | { ok: false; error: string };

let sharedEnvironment: Environment | null = null;

/**
 * How many parsed expressions this process keeps.
 *
 * The cache earns its place twice over: a Condition node's expression is parsed
 * once and evaluated on every run, and a parked run's wait match is evaluated on
 * every arrival of its Event until the run resumes or its timeout expires. The
 * bound is here because the second caller's key is generated rather than
 * authored -- `compileWaitSubscriptions` inlines the run's own Entity Value as a
 * literal, so cardinality follows the parked population and an unbounded map
 * would hold one entry per entity ever parked, for the life of the process.
 */
const PARSED_EXPRESSION_CACHE_LIMIT = 2000;

const parsedExpressionCache = new Map<string, ParsedExpression>();

function isParsedExpression(value: unknown): value is ParsedExpression {
  return typeof value === "function";
}

/**
 * Recover the CEL library's own Duration class from a Duration it produced, so
 * this module can build more of them without reaching for a private export.
 *
 * Arrays are turned away alongside primitives: an array here would mean the
 * library stopped handing back Duration instances, and `Array` as the
 * constructor would build nonsense durations in place of failing at startup.
 */
function getDurationFactory(value: unknown): DurationFactory | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const maybeConstructor = value.constructor;
  if (typeof maybeConstructor !== "function") {
    return null;
  }

  return (seconds, nanos = 0) =>
    Reflect.construct(maybeConstructor, [seconds, nanos]);
}

function normalizeCelInt(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }

  throw new Error("Expected integer argument");
}

function createDuration(
  factory: DurationFactory,
  totalSeconds: bigint
): unknown {
  return factory(totalSeconds, 0);
}

/**
 * Read the argument of a `date(...)` call in a condition expression.
 *
 * A bare calendar day is the shorthand the condition builder emits when the
 * user picks a date without a time, so it is widened to midnight UTC before it
 * reaches the shared timestamp contract. Everything else has to name an instant
 * on its own, zone included.
 */
function parseDateStringToTimestamp(value: string): Date {
  const trimmed = value.trim();
  const parsed = decodeIsoTimestamp(
    DATE_ONLY_PATTERN.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed
  );

  if (!parsed) {
    throw new Error("date() requires a valid ISO date string");
  }

  return parsed;
}

function createCelEnvironment(): Environment {
  const environment = new Environment({
    unlistedVariablesAreDyn: true,
  });

  environment.registerVariable("now", TIMESTAMP_TYPE);

  const durationFactory = getDurationFactory(
    environment.evaluate('duration("1s")')
  );
  if (!durationFactory) {
    throw new Error("Failed to initialize CEL duration constructor");
  }

  environment.registerFunction(`minutes(int): ${DURATION_TYPE}`, (value) => {
    const minutes = normalizeCelInt(value);
    return createDuration(durationFactory, minutes * BIGINT_60);
  });

  environment.registerFunction(`hours(int): ${DURATION_TYPE}`, (value) => {
    const hours = normalizeCelInt(value);
    return createDuration(durationFactory, hours * BIGINT_60 * BIGINT_60);
  });

  environment.registerFunction(`days(int): ${DURATION_TYPE}`, (value) => {
    const days = normalizeCelInt(value);
    return createDuration(
      durationFactory,
      days * BIGINT_24 * BIGINT_60 * BIGINT_60
    );
  });

  environment.registerFunction(`weeks(int): ${DURATION_TYPE}`, (value) => {
    const weeks = normalizeCelInt(value);
    return createDuration(
      durationFactory,
      weeks * BIGINT_7 * BIGINT_24 * BIGINT_60 * BIGINT_60
    );
  });

  environment.registerFunction(`date(string): ${TIMESTAMP_TYPE}`, (value) => {
    if (typeof value !== "string") {
      throw new Error("date() requires a string argument");
    }

    return parseDateStringToTimestamp(value);
  });

  return environment;
}

function getEnvironment(): Environment {
  if (sharedEnvironment) {
    return sharedEnvironment;
  }

  sharedEnvironment = createCelEnvironment();
  return sharedEnvironment;
}

/**
 * The parsed form of one expression, least-recently-used eviction over a Map.
 *
 * A Map iterates in insertion order, so re-inserting on a hit moves the entry to
 * the end and the first key is always the coldest one.
 */
function getParsedExpression(expression: string): ParsedExpression {
  const cached = parsedExpressionCache.get(expression);
  if (cached) {
    parsedExpressionCache.delete(expression);
    parsedExpressionCache.set(expression, cached);
    return cached;
  }

  const parsed = getEnvironment().parse(expression);
  if (!isParsedExpression(parsed)) {
    throw new Error("CEL parser did not return an executable expression");
  }

  if (parsedExpressionCache.size >= PARSED_EXPRESSION_CACHE_LIMIT) {
    const coldest = parsedExpressionCache.keys().next();
    if (!coldest.done) {
      parsedExpressionCache.delete(coldest.value);
    }
  }

  parsedExpressionCache.set(expression, parsed);
  return parsed;
}

function normalizeExpression(expression: string): string {
  return expression.trim();
}

export function checkCelBooleanExpression(
  expression: string
): CelValidationResult {
  const normalized = normalizeExpression(expression);
  if (!normalized) {
    return { ok: false, error: "CEL expression cannot be empty" };
  }

  try {
    const check = getEnvironment().check(normalized);
    if (!check.valid) {
      return {
        ok: false,
        error: check.error?.message || "CEL expression is invalid",
      };
    }

    if (check.type && check.type !== "bool") {
      return {
        ok: false,
        error: `CEL expression must return bool, got ${check.type}`,
      };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "CEL expression is invalid",
    };
  }
}

export function evaluateCelBooleanExpression(input: {
  expression: string;
  context: Record<string, unknown>;
}): CelEvaluationResult {
  const normalized = normalizeExpression(input.expression);
  if (!normalized) {
    return { ok: false, error: "CEL expression cannot be empty" };
  }

  try {
    const parsed = getParsedExpression(normalized);
    const result = parsed(input.context);

    if (typeof result !== "boolean") {
      return {
        ok: false,
        error: "CEL expression did not evaluate to a boolean",
      };
    }

    return { ok: true, value: result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "CEL evaluation failed",
    };
  }
}
