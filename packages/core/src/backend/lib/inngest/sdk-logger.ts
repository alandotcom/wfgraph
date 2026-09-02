/**
 * The Inngest SDK's own messages, sent to logtape instead of the console.
 *
 * The SDK's `Logger` takes a rest argument of anything, and calls it two ways:
 * plain (`info("Connecting")`) and pino-style with the fields first
 * (`info({ connectionId }, "Connection established")`). Both arrive here, and
 * both leave as one logtape record with a message and a property bag, so the
 * Connect handshake reads like every other line rather than as a bare object
 * printed by `console.log`.
 */

import { isEmptyObject, isPlainObject } from "es-toolkit/predicate";
import { getAppLogger } from "#src/backend/lib/logger";

type SdkLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
};

/**
 * The first string is the message and every object is a field bag. Anything
 * else (a number, an Error, an array) is kept under a numbered key rather than
 * dropped, because the SDK is free to pass it and losing it silently is worse
 * than an odd key name.
 */
function splitSdkArgs(input: unknown[]): {
  message: string;
  properties: Record<string, unknown> | undefined;
} {
  const properties: Record<string, unknown> = {};
  let message: string | undefined;
  let extras = 0;

  for (const arg of input) {
    if (message === undefined && typeof arg === "string") {
      message = arg;
    } else if (isPlainObject(arg)) {
      Object.assign(properties, arg);
    } else {
      properties[`arg${extras}`] = arg;
      extras += 1;
    }
  }

  return {
    message: message ?? "Inngest SDK message",
    properties: isEmptyObject(properties) ? undefined : properties,
  };
}

/**
 * The logger handed to the Inngest client as `internalLogger`, which is what
 * the SDK's registration, request parsing and Connect handshake write through.
 * `ctx.logger` inside a handler is the separate `logger` option and stays the
 * SDK's own, so a host's handler keeps whatever it had.
 */
export function createInngestSdkLogger(): SdkLogger {
  const logger = getAppLogger("inngest");

  return {
    // The SDK narrates its handshake at info across four calls, and Workflow
    // Graph writes its own line for the outcome. Debug is where that narration
    // is worth reading, which is while a handshake is failing.
    info: (...args) => {
      const { message, properties } = splitSdkArgs(args);
      logger.debug(message, properties);
    },
    warn: (...args) => {
      const { message, properties } = splitSdkArgs(args);
      logger.warn(message, properties);
    },
    error: (...args) => {
      const { message, properties } = splitSdkArgs(args);
      logger.error(message, properties);
    },
    debug: (...args) => {
      const { message, properties } = splitSdkArgs(args);
      logger.debug(message, properties);
    },
  };
}
