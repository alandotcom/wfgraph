import { Environment } from "@marcbachmann/cel-js";

const TIMESTAMP_TYPE = "google.protobuf.Timestamp";
const DURATION_TYPE = "google.protobuf.Duration";
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BIGINT_7 = BigInt(7);
const BIGINT_24 = BigInt(24);
const BIGINT_60 = BigInt(60);

type DurationConstructor = new (
  seconds: bigint | number,
  nanos?: number
) => unknown;

export type CelValidationResult = { ok: true } | { ok: false; error: string };

export type CelEvaluationResult =
  | { ok: true; value: boolean }
  | { ok: false; error: string };

let sharedEnvironment: Environment | null = null;
const parsedExpressionCache = new Map<string, (context?: unknown) => unknown>();

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
  ctor: DurationConstructor,
  totalSeconds: bigint
): unknown {
  return new ctor(totalSeconds, 0);
}

function parseDateStringToTimestamp(value: string): Date {
  const trimmed = value.trim();

  if (DATE_ONLY_PATTERN.test(trimmed)) {
    const timestamp = new Date(`${trimmed}T00:00:00.000Z`);
    if (!Number.isNaN(timestamp.getTime())) {
      return timestamp;
    }
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("date() requires a valid ISO date string");
  }

  return parsed;
}

function createCelEnvironment(): Environment {
  const environment = new Environment({
    unlistedVariablesAreDyn: true,
  });

  environment.registerVariable("now", TIMESTAMP_TYPE);

  const durationConstructor = environment.evaluate('duration("1s")') as {
    constructor?: DurationConstructor;
  };

  const DurationCtor = durationConstructor.constructor;
  if (!DurationCtor) {
    throw new Error("Failed to initialize CEL duration constructor");
  }

  environment.registerFunction(`minutes(int): ${DURATION_TYPE}`, (value) => {
    const minutes = normalizeCelInt(value);
    return createDuration(DurationCtor, minutes * BIGINT_60);
  });

  environment.registerFunction(`hours(int): ${DURATION_TYPE}`, (value) => {
    const hours = normalizeCelInt(value);
    return createDuration(DurationCtor, hours * BIGINT_60 * BIGINT_60);
  });

  environment.registerFunction(`days(int): ${DURATION_TYPE}`, (value) => {
    const days = normalizeCelInt(value);
    return createDuration(
      DurationCtor,
      days * BIGINT_24 * BIGINT_60 * BIGINT_60
    );
  });

  environment.registerFunction(`weeks(int): ${DURATION_TYPE}`, (value) => {
    const weeks = normalizeCelInt(value);
    return createDuration(
      DurationCtor,
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

function getParsedExpression(
  expression: string
): (context?: unknown) => unknown {
  const cached = parsedExpressionCache.get(expression);
  if (cached) {
    return cached;
  }

  const parsed = getEnvironment().parse(expression) as (
    context?: unknown
  ) => unknown;
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
