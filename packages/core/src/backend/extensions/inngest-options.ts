/**
 * The Inngest flow control an Event may declare, and its translation into what
 * `createFunction` takes.
 *
 * An Event Author writes every path against the payload, so the translation
 * into the `event.data.` form belongs somewhere; `defineEvent` is the only
 * caller, and this sits beside it. The prefixing and the CEL rewrite themselves
 * are `@wfgraph/shared/lifecycle/inngest-event-data`, because a path and an
 * expression over a payload are the same problem wherever they are written.
 */

import type { InngestFunction } from "inngest";
import type { JsonObject } from "@wfgraph/shared/types/json";
import type { PayloadPath } from "@wfgraph/shared/types/payload-path";
import {
  extractSchemaKeys,
  type StandardSchema,
} from "@wfgraph/shared/types/schema";
import {
  prefixKeyField,
  rewriteCelExpression,
} from "@wfgraph/shared/lifecycle/inngest-event-data";

type FunctionOptions = InngestFunction.Options;

/**
 * One Inngest option with its partition key retyped as a payload path.
 *
 * Everything else about the option is the SDK's, so `period: "1 hour"` and a
 * retry count past 20 fail the Event author's build rather than Inngest's sync,
 * and a field Inngest adds or re-constrains arrives here for free.
 */
type WithPayloadKey<TOption, TPayload extends JsonObject> = Omit<
  NonNullable<TOption>,
  "key"
> & {
  /** Schema-relative dot-path to partition by. */
  key?: PayloadPath<TPayload> | undefined;
};

/**
 * Inngest flow control for an Event's listener, written against the payload.
 *
 * Inngest `concurrency` is not a member. Per-Entity-Value serialization is
 * Workflow Graph's Concurrency on the Lifecycle Node, which Inngest's version cannot
 * stand in for: it can neither end a displaced run with the `superseded` status
 * nor refuse a start and say so in run history.
 */
export type InngestEventOptions<TPayload extends JsonObject> = {
  rateLimit?:
    | WithPayloadKey<FunctionOptions["rateLimit"], TPayload>
    | undefined;
  throttle?: WithPayloadKey<FunctionOptions["throttle"], TPayload> | undefined;
  debounce?: WithPayloadKey<FunctionOptions["debounce"], TPayload> | undefined;
  /**
   * Dynamic priority, evaluated at enqueue time. Higher runs first. `run` is
   * required here where the SDK leaves it optional: an empty `priority` says
   * nothing, and the rewrite below has an expression to translate.
   *
   * @example
   * ```ts
   * priority: { run: 'appointment.priority == "high" ? 100 : 50' }
   * // becomes: 'event.data.appointment.priority == "high" ? 100 : 50'
   * ```
   */
  priority?: { run: string } | undefined;
  timeouts?: FunctionOptions["timeouts"] | undefined;
  retries?: FunctionOptions["retries"] | undefined;
};

/** What `createFunction` is handed, once every path is under `event.data`. */
type RewrittenInngestOptions = Pick<
  FunctionOptions,
  "rateLimit" | "throttle" | "debounce" | "priority" | "timeouts" | "retries"
>;

/**
 * The two Inngest options an Event may not carry.
 *
 * `batchEvents` changes the handler signature, so a listener cannot honour it.
 * `concurrency` would quietly take over what Concurrency on the Lifecycle Node
 * does, and do it with no status and no run-history row. The type above declares
 * neither, so this is here for the object that arrived by a spread.
 *
 * The parameter is `object` because the body only reads key presence, and
 * `InngestEventOptions` is invariant in its payload type: naming it here would
 * refuse every caller whose payload is not exactly `JsonObject`.
 */
function assertNoRetiredInngestOptions(
  eventName: string,
  inngest: object
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
  // Untyped: `extractSchemaKeys` reads field names off the schema object itself,
  // its `shape` or `fields` container, and a CEL identifier is checked against
  // those. No type is read, and no JSON Schema is derived here.
  schema: StandardSchema<unknown>
): RewrittenInngestOptions {
  assertNoRetiredInngestOptions(eventName, inngest);

  const result: RewrittenInngestOptions = {};

  // Each of the three drops `key` when the Event named none: Inngest's own
  // option types spell it as a plain optional string, which refuses a property
  // that is present and holds `undefined`.
  if (inngest.rateLimit) {
    const { key, ...rest } = prefixKeyField(inngest.rateLimit);
    result.rateLimit = key === undefined ? rest : { ...rest, key };
  }

  if (inngest.throttle) {
    const { key, ...rest } = prefixKeyField(inngest.throttle);
    result.throttle = key === undefined ? rest : { ...rest, key };
  }

  if (inngest.debounce) {
    const { key, ...rest } = prefixKeyField(inngest.debounce);
    result.debounce = key === undefined ? rest : { ...rest, key };
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
