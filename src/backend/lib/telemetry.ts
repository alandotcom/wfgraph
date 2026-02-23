import { SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("rova-workflows", "0.1.0");

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
