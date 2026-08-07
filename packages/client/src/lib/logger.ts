/// <reference types="vite/client" />

/**
 * Logging for the editor, categorised the way the backend's is.
 *
 * A development build routes through logtape's console sink, which the browser
 * renders with CSS styling, a `wfgraph.<area>` category and a level per line. A
 * production build folds `import.meta.env.DEV` to `false`, and every reference
 * to logtape then falls to dead-code elimination: what ships forwards warnings
 * and failures to the console and drops the chatter.
 */

import { configureSync, getConsoleSink, getLogger } from "@logtape/logtape";

/** The one category prefix every editor logger hangs off. */
const LOGGER_ROOT = "wfgraph";

/** What a call site may say. One line, plus a bag of structured fields. */
export type ClientLogger = {
  debug: (message: string, properties?: Record<string, unknown>) => void;
  info: (message: string, properties?: Record<string, unknown>) => void;
  warn: (message: string, properties?: Record<string, unknown>) => void;
  error: (message: string, properties?: Record<string, unknown>) => void;
};

let isConfigured = false;

function developmentLogger(category: string[]): ClientLogger {
  if (!isConfigured) {
    configureSync({
      sinks: { console: getConsoleSink() },
      loggers: [
        { category: LOGGER_ROOT, sinks: ["console"], lowestLevel: "debug" },
        // logtape announces itself through the meta logger on every configure
        // and warns when the meta logger is left unconfigured. Raising it to
        // "error" keeps the startup notice out of the console while still
        // surfacing a sink that throws.
        { category: "logtape", sinks: ["console"], lowestLevel: "error" },
        {
          category: ["logtape", "meta"],
          sinks: ["console"],
          lowestLevel: "error",
        },
      ],
    });
    isConfigured = true;
  }

  const logger = getLogger([LOGGER_ROOT, ...category]);
  return {
    debug: (message, properties) => logger.debug(message, properties),
    info: (message, properties) => logger.info(message, properties),
    warn: (message, properties) => logger.warn(message, properties),
    error: (message, properties) => logger.error(message, properties),
  };
}

/** Every level a production build drops, sharing one function. */
function ignore(): void {}

function productionLogger(category: string[]): ClientLogger {
  const prefix = `[${[LOGGER_ROOT, ...category].join(".")}]`;
  return {
    debug: ignore,
    info: ignore,
    warn: (message, properties) => console.warn(prefix, message, properties),
    error: (message, properties) => console.error(prefix, message, properties),
  };
}

/**
 * The logger for one area of the editor, named the way its module is:
 * `getClientLogger("workflow", "save")` logs under `wfgraph.workflow.save`.
 */
export function getClientLogger(...category: string[]): ClientLogger {
  return import.meta.env.DEV
    ? developmentLogger(category)
    : productionLogger(category);
}
