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

/**
 * Keep request resources alive until an event-stream body ends or is canceled.
 * With `defer`, the closes of a response that is not a stream, and of a
 * stream the client canceled, are handed to it rather than awaited, so the
 * response does not wait for them; `defer` owns their failures. A Worker
 * passes its `ctx.waitUntil` here.
 */
export async function runWithResponseClose(
  run: () => Promise<Response>,
  closes: readonly (() => Promise<void>)[],
  options?: { defer?: ((close: () => Promise<void>) => void) | undefined }
): Promise<Response> {
  const defer = options?.defer;
  let response: Response;
  try {
    response = await run();
  } catch (operationError) {
    return await failWithCleanup(
      operationError,
      closes,
      "The request and resource cleanup both failed"
    );
  }

  if (
    !response.body ||
    !response.headers.get("content-type")?.startsWith("text/event-stream")
  ) {
    if (defer === undefined) {
      await closeInOrder(closes);
    } else {
      defer(() => closeInOrder(closes));
    }
    return response;
  }

  const reader = response.body.getReader();
  let closePromise: Promise<void> | undefined;
  const closeOnce = () => (closePromise ??= closeInOrder(closes));
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          await closeOnce();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (operationError) {
        try {
          await failWithCleanup(
            operationError,
            [closeOnce],
            "The response stream and resource cleanup both failed"
          );
        } catch (error) {
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      const cancelThenClose = () =>
        runWithClose(() => reader.cancel(reason), [closeOnce]);
      if (defer === undefined) {
        await cancelThenClose();
      } else {
        defer(cancelThenClose);
      }
    },
  });

  return new Response(body, response);
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
