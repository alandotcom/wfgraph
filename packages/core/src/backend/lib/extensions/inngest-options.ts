/**
 * The Inngest flow control an Event may declare, and its translation into what
 * `createFunction` takes.
 *
 * An Event Author writes every path against the payload, so the translation into
 * the `event.data.` form belongs somewhere; `defineEvent` is the only caller, and
 * this sits beside it. The prefixing and the CEL rewrite themselves are
 * `@rova/shared/workflow/inngest-event-data`, since a path and an expression over
 * a payload are the same problem wherever they are written.
 */

import type { JsonObject } from "@rova/shared/types/json";
import type { PayloadPath } from "@rova/shared/types/payload-path";
import {
  extractSchemaKeys,
  type StandardSchema,
} from "@rova/shared/types/schema";
import {
  prefixKeyField,
  rewriteCelExpression,
} from "@rova/shared/workflow/inngest-event-data";

/**
 * Inngest flow control for an Event's listener, written against the payload.
 *
 * Inngest `concurrency` is not a member. Per-Entity-Value serialization is
 * Rova's Concurrency on the Lifecycle Node, which Inngest's version cannot
 * stand in for: it can neither end a displaced run with the `superseded` status
 * nor refuse a start and say so in run history.
 */
export type InngestEventOptions<TPayload extends JsonObject> = {
  /**
   * Limit how many times the listener runs within a time period. When `key` is
   * set, the limit is tracked per unique key value.
   */
  rateLimit?: {
    /** Maximum number of runs allowed per `period`. */
    limit: number;
    /** Time window (e.g. `"1m"`, `"1h"`). */
    period: string;
    /** Schema-relative dot-path to partition the rate limit by. */
    key?: PayloadPath<TPayload>;
  };
  /** Limit throughput over a rolling window. */
  throttle?: {
    /** Maximum number of runs in the rolling `period`. */
    limit: number;
    /** Rolling window duration (e.g. `"1h"`). */
    period: string;
    /** Schema-relative dot-path to partition the throttle by. */
    key?: PayloadPath<TPayload>;
    /** Number of burst runs allowed above the steady-state limit. */
    burst?: number;
  };
  /**
   * Delay running until no new matching Event arrives within `period`. Only the
   * last Event in the window is delivered.
   */
  debounce?: {
    /** Debounce window (e.g. `"5s"`, `"1m"`). */
    period: string;
    /** Schema-relative dot-path to partition the debounce by. */
    key?: PayloadPath<TPayload>;
    /** Maximum time to wait before forcing delivery (e.g. `"1h"`). */
    timeout?: string;
  };
  /**
   * Dynamic priority, evaluated at enqueue time. Higher runs first.
   *
   * @example
   * ```ts
   * priority: { run: 'appointment.priority == "high" ? 100 : 50' }
   * // becomes: 'event.data.appointment.priority == "high" ? 100 : 50'
   * ```
   */
  priority?: {
    /** CEL expression using schema-relative identifiers. */
    run: string;
  };
  /** Inngest timeout overrides. */
  timeouts?: {
    /** Max time to wait before the listener starts (e.g. `"1h"`). */
    start?: string;
    /** Max time it may run after starting (e.g. `"2h"`). */
    finish?: string;
  };
  /** Number of automatic retries on failure. */
  retries?: number;
};

/**
 * The two Inngest options an Event may not carry.
 *
 * `batchEvents` changes the handler signature, so a listener cannot honour it.
 * `concurrency` would quietly take over what Concurrency on the Lifecycle Node
 * does, and do it with no status and no run-history row. The type above declares
 * neither, so this is here for the object that arrived by a spread.
 */
function assertNoRetiredInngestOptions(
  eventName: string,
  inngest: InngestEventOptions<JsonObject>
): void {
  if ("batchEvents" in inngest) {
    throw new Error(
      `Event "${eventName}" sets inngest.batchEvents, which changes the handler signature and cannot be honoured by an Event listener.`
    );
  }

  if ("concurrency" in inngest) {
    throw new Error(
      `Event "${eventName}" sets inngest.concurrency. How many runs may exist per Entity Value is Concurrency on the workflow's Lifecycle Node, which Inngest's concurrency cannot express: it can neither end a displaced run with a status nor record a refused start.`
    );
  }
}

/**
 * Rewrite one Event's authored flow control into the object Inngest takes,
 * refusing the options no listener can honour.
 *
 * `eventName` appears in those refusals, so the message names the Event rather
 * than the option alone. `schema` is read for its top-level field names, which
 * is what a `priority.run` identifier is checked against.
 */
export function rewriteInngestOptions<TPayload extends JsonObject>(
  eventName: string,
  inngest: InngestEventOptions<TPayload>,
  schema: StandardSchema<TPayload>
): Record<string, unknown> {
  assertNoRetiredInngestOptions(eventName, inngest);

  const result: Record<string, unknown> = {};

  if (inngest.rateLimit) {
    result.rateLimit = prefixKeyField(inngest.rateLimit);
  }

  if (inngest.throttle) {
    result.throttle = prefixKeyField(inngest.throttle);
  }

  if (inngest.debounce) {
    result.debounce = prefixKeyField(inngest.debounce);
  }

  if (inngest.priority) {
    result.priority = {
      run: rewriteCelExpression(
        inngest.priority.run,
        extractSchemaKeys(schema)
      ),
    };
  }

  if (inngest.timeouts) {
    result.timeouts = inngest.timeouts;
  }

  if (inngest.retries !== undefined) {
    result.retries = inngest.retries;
  }

  return result;
}
