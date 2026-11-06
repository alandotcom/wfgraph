/**
 * Records a case caused, read back. `recordedLogger` keeps what the bridge
 * hands a host `logger`, and its `find` ignores the bracketed category the
 * bridge prefixes. `recordingLogger` keeps every line an Effect writes, at
 * every level, with its annotations.
 */

import { Layer, Logger, References } from "effect";

type Kept = { message: string; properties: unknown };

export function recordedLogger() {
  const records: Kept[] = [];
  const keep = (message: unknown, properties: unknown) => {
    records.push({ message: String(message), properties });
  };
  return {
    logger: { info: keep, warn: keep, error: keep },
    find: (message: string): Kept[] =>
      records.filter((record) => record.message.endsWith(`] ${message}`)),
  };
}

/** Captures every log line an Effect writes, with its annotations. */
export function recordingLogger() {
  const lines: { message: unknown; annotations: Record<string, unknown> }[] =
    [];
  const logger = Logger.make<unknown, void>(({ fiber, message }) => {
    lines.push({
      message: Array.isArray(message) ? message[0] : message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });
  return {
    lines,
    layer: Layer.merge(
      Logger.layer([logger]),
      Layer.succeed(References.MinimumLogLevel, "All")
    ),
  };
}
