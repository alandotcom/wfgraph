/**
 * `events` on what `createWfGraphApp` and `createWfGraphRunner` answer: a
 * host's in-process send into the event inbox, and the inbox insert a host
 * runs in its own transaction. `send` resolves once the inbox row has
 * committed; `inboxInsert` writes nothing. Each rejects with
 * `WfGraphEventRefused` for a call the caller can correct, and `send` also with
 * an `Error` whose `cause` holds the storage failure or the defect, such as a
 * send after the app was disposed. No message quotes what the caller sent.
 */

import { Cause, Effect, Exit, Option, Result, Schema } from "effect";
import type { AnyEventDefinition } from "#src/backend/extensions/define-event";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import type { InboxInsertStatement } from "#src/backend/persistence/inbox-insert";
import type { WfGraphRuntime } from "#src/backend/runtime";
import { sendEvent } from "#src/backend/services/executions/send-event";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { NonEmptyTrimmedString } from "@wfgraph/shared/types/schema";
import { isBlank } from "@wfgraph/shared/types/string";

/** How Events reach this app's event inbox, and how long the inbox keeps them. */
export type WfGraphEventsOptions = {
  /**
   * The shared key that mounts `POST {basePath}/api/events`. A sender
   * presents it as `Authorization: Bearer <key>`, so it holds no
   * whitespace. Absent, the route is not
   * mounted, and `app.events.send` stays the only way in besides webhook
   * intake and a host's own insert. Treat it as a secret, like `encryption.key`.
   */
  key?: string | undefined;
  /**
   * How long a delivered or failed inbox row is kept after it arrived, in
   * milliseconds: a positive integer of at most 100 years, or startup refuses
   * it. Defaults to seven days. This is also the deduplication
   * window: a send whose idempotency key matches a row still kept answers
   * with that row, and once the sweep has deleted the row the same key is a
   * new arrival. Every process that runs a worker loop sweeps with its own
   * window, so a host running loops in more than one process, such as an
   * app beside `createWfGraphRunner`, sets the same window in each. A pending
   * row is never deleted.
   */
  retentionMs?: number | undefined;
};

/** One Event as a host raises it. */
export type WfGraphEventInput = {
  /** The name of an Event in the app's catalog. */
  name: string;
  /** The payload, checked against that Event's schema. */
  data: JsonObject;
  /**
   * The idempotency key. A second send with the same name and id is answered
   * with the first send's inbox row while that row exists, and opens nothing.
   */
  id?: string | undefined;
};

/** The options a send or an inbox insert takes beside the Event and its payload. */
export type WfGraphEventSendOptions = {
  /**
   * The idempotency key. A second send with the same Event and id is answered
   * with the first send's inbox row while that row exists, and opens nothing.
   */
  id?: string | undefined;
};

/**
 * An Event definition from `defineEvent`, read for its name and the payload
 * type its schema accepts. Covers every validated type, since a send carries
 * the payload as it arrives.
 */
type SendableEvent<TPayload extends JsonObject> = {
  readonly kind: "event";
  readonly name: string;
  readonly _payload?: TPayload | undefined;
};

/**
 * The documented inbox insert for one Event, for a host to run on its own
 * connection inside its own transaction. `sql` names this app's table, schema
 * qualified on PostgreSQL. `params` holds `$1` the Event name, `$2` the
 * payload, and `$3` the idempotency key or null, for a driver that binds `$1`
 * by position, such as postgres.js or node-postgres. `$2` is the payload
 * object on PostgreSQL, which the driver encodes for the `jsonb` column, and
 * the payload as JSON text on SQLite. `namedParams` holds the same values
 * keyed `$1` to `$3`, for a driver that binds a `$1` parameter by name, such
 * as `node:sqlite`.
 */
export type WfGraphInboxInsert = {
  readonly sql: string;
  readonly params: readonly [
    name: string,
    data: JsonObject | string,
    idempotencyKey: string | null,
  ];
  readonly namedParams: {
    readonly $1: string;
    readonly $2: JsonObject | string;
    readonly $3: string | null;
  };
};

/** What a send answers. */
export type WfGraphEventReceipt = {
  /** The inbox row that holds the arrival. */
  id: string;
  /** Whether an earlier send with the same `id` already held that row. */
  duplicate: boolean;
};

export type WfGraphEvents = {
  /**
   * Validates the Event against the catalog and records it in the event
   * inbox, where the worker loop delivers it to every workflow it starts,
   * cancels or wakes. Takes the definition `defineEvent` returned, which
   * types `data` from its schema, or a `{ name, data, id }` object for a
   * sender that holds only a name.
   */
  send: {
    <TPayload extends JsonObject>(
      event: SendableEvent<TPayload>,
      data: NoInfer<TPayload>,
      options?: WfGraphEventSendOptions
    ): Promise<WfGraphEventReceipt>;
    (event: WfGraphEventInput): Promise<WfGraphEventReceipt>;
  };
  /**
   * Checks `data` against the Event's schema, as `send` does, and answers the
   * documented inbox insert for it without writing anything. The host runs the
   * statement on its own connection inside its own transaction, so the Event
   * is stored exactly when that transaction commits. The Event must be a host
   * Event of this app, sent under its own name.
   */
  inboxInsert: <TPayload extends JsonObject>(
    event: SendableEvent<TPayload>,
    data: NoInfer<TPayload>,
    options?: WfGraphEventSendOptions
  ) => Promise<WfGraphInboxInsert>;
  /**
   * The names host-declared Events arrive under: each host Event's
   * `source.event`, which is the Event's own name unless it arrives on an
   * umbrella source, once each. They are read from the same assembled
   * extensions `send` resolves a name against. An Event owned by an
   * integration arrives through its Connection and is not listed.
   */
  readonly sourceNames: readonly string[];
};

/**
 * A send the caller can correct: a name no catalog Event has, a payload the
 * Event's schema refuses, or a malformed argument. The message names fields
 * and rules.
 */
export class WfGraphEventRefused extends Error {
  override readonly name = "WfGraphEventRefused";
}

/**
 * Whether `error` is a `WfGraphEventRefused`, read from its `name`. A bundled
 * entry such as `@wfgraph/core/inngest` can hold its own copy of the class,
 * where `instanceof` against another copy answers false.
 */
export function isWfGraphEventRefused(error: unknown): error is Error {
  return error instanceof Error && error.name === "WfGraphEventRefused";
}

/**
 * Refuses an `events.key` no sender could present: a blank key, or one
 * holding whitespace, which a single Bearer token cannot carry. `caller`
 * names the function the host called.
 */
export function assertValidEventsKey(
  key: string | undefined,
  caller: string
): void {
  if (key === undefined) return;
  if (isBlank(key)) {
    throw new Error(
      `${caller}'s events.key is blank. Pass a secret to mount POST /api/events, or leave the key out to keep that route off.`
    );
  }
  if (/\s/u.test(key)) {
    throw new Error(
      `${caller}'s events.key contains whitespace, which an Authorization: Bearer header cannot carry. Pass a key without spaces, tabs or line breaks.`
    );
  }
}

const readIdempotencyKey = Schema.decodeUnknownResult(NonEmptyTrimmedString);

/** Whether `send` was called with a definition rather than a `{ name, data }` object. */
function isEventDefinition(
  value: SendableEvent<JsonObject> | WfGraphEventInput
): value is SendableEvent<JsonObject> {
  return "kind" in value && value.kind === "event";
}

/**
 * The inbox row's values for `definition` and `data`, refused as
 * `WfGraphEventRefused` when the Event is not a host Event of this app under
 * its own name, the payload fails its schema, or the key is blank.
 */
async function readInboxRow(
  extensions: ExtensionSet,
  definition: SendableEvent<JsonObject>,
  data: JsonObject,
  options: WfGraphEventSendOptions | undefined
): Promise<{ name: string; idempotencyKey: string | null }> {
  const match = extensions.resolveArrival({
    name: definition.name,
    data,
    connectionId: null,
  });
  const event: AnyEventDefinition | undefined =
    match.kind === "event" ? match.event : undefined;
  if (event?.name !== definition.name) {
    throw new WfGraphEventRefused(
      "event: This app declares no host Event with this definition's name"
    );
  }
  const decoded = await Effect.runPromiseExit(event.decodePayloadValue(data));
  if (Exit.isFailure(decoded)) {
    const rejected = Cause.findErrorOption(decoded.cause);
    throw new WfGraphEventRefused(
      Option.isSome(rejected)
        ? `Payload refused for Event "${event.name}": ${rejected.value.error}`
        : `Payload refused for Event "${event.name}"`
    );
  }
  let idempotencyKey: string | null = null;
  if (options?.id !== undefined) {
    const key = readIdempotencyKey(options.id);
    if (Result.isFailure(key)) {
      throw new WfGraphEventRefused("id: Expected a non-empty string");
    }
    idempotencyKey = key.success;
  }
  return { name: event.name, idempotencyKey };
}

/**
 * The host's send over `runtime`. `extensions` is the set the runtime was
 * built on, which `sourceNames` is read from. `inboxInsert` is the opened
 * backend's documented insert, absent on a backend a host does not share.
 */
export function createHostEvents(
  runtime: WfGraphRuntime,
  extensions: ExtensionSet,
  inboxInsert: InboxInsertStatement | undefined
): WfGraphEvents {
  const send = async (
    event: SendableEvent<JsonObject> | WfGraphEventInput,
    data?: JsonObject,
    options?: WfGraphEventSendOptions
  ): Promise<WfGraphEventReceipt> => {
    const input: WfGraphEventInput = isEventDefinition(event)
      ? { name: event.name, data: data ?? {}, id: options?.id }
      : event;
    // An exit rather than a rejected promise, so a defect, such as a send
    // after the app was disposed, is answered as the storage failure it is
    // to the host and never escapes as whatever the runtime threw.
    const exit = await runtime.runPromiseExit(sendEvent(input));
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.findErrorOption(exit.cause);
    if (Option.isSome(failure)) {
      if (failure.value._tag === "InvalidInput") {
        throw new WfGraphEventRefused(failure.value.error);
      }
      throw new Error(failure.value.error, { cause: failure.value.cause });
    }
    throw new Error("Could not send this Event", {
      cause: Cause.squash(exit.cause),
    });
  };
  return {
    sourceNames: extensions.hostEventSources,
    send,
    inboxInsert: async (definition, data, options) => {
      if (inboxInsert === undefined) {
        throw new Error(
          "This persistence backend takes no inbox insert from a host's own connection"
        );
      }
      const { name, idempotencyKey } = await readInboxRow(
        extensions,
        definition,
        data,
        options
      );
      const payload =
        inboxInsert.data === "object" ? data : JSON.stringify(data);
      return {
        sql: inboxInsert.sql,
        params: [name, payload, idempotencyKey],
        namedParams: { $1: name, $2: payload, $3: idempotencyKey },
      };
    },
  };
}
