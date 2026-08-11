function aggregateFailures(
  failures: readonly unknown[],
  message: string,
  cause: unknown
): AggregateError {
  return new AggregateError(failures, message, { cause });
}

async function failWithCleanup(
  operationError: unknown,
  closes: readonly (() => Promise<void>)[],
  message: string
): Promise<never> {
  try {
    await closeInOrder(closes);
  } catch (closeError) {
    throw aggregateFailures(
      [operationError, closeError],
      message,
      operationError
    );
  }
  throw operationError;
}

/** Release resources in dependency order, attempting every close even after one fails. */
export async function closeInOrder(
  closes: readonly (() => Promise<void>)[]
): Promise<void> {
  const failures: unknown[] = [];

  for (const close of closes) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Resources must close in dependency order.
      await close();
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Several resources failed to close", {
      cause: failures[0],
    });
  }
}

/** Run one operation, then release its resources without hiding either failure. */
export async function runWithClose<A>(
  run: () => Promise<A>,
  closes: readonly (() => Promise<void>)[]
): Promise<A> {
  let result: A;
  try {
    result = await run();
  } catch (operationError) {
    return await failWithCleanup(
      operationError,
      closes,
      "The operation and resource cleanup both failed"
    );
  }

  await closeInOrder(closes);
  return result;
}

/** Release partially acquired resources before propagating a startup failure. */
export function failAfterClose(
  operationError: unknown,
  closes: readonly (() => Promise<void>)[]
): Promise<never> {
  return failWithCleanup(
    operationError,
    closes,
    "Startup and resource cleanup both failed"
  );
}
