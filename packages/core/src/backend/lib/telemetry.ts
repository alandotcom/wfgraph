import { SpanStatusCode, trace } from "@opentelemetry/api";

/**
 * The instrumentation scope every Rova span arrives under: the engine's own,
 * below, and the Effect spans `effect/tracer.ts` bridges. One scope is what lets
 * a reader of the trace treat the two halves as one library.
 */
export const TRACER_NAME = "rova-workflows";
export const TRACER_VERSION = "0.1.0";

const tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);

export function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) {
        span.setAttribute(key, value);
      }
    }

    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Error) {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  });
}
