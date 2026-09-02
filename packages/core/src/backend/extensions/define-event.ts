/**
 * An Event: a name, a payload shape, and where that payload carries its Entity
 * Value.
 *
 * An Event holds no lifecycle role and no routing. Which Events start a run and
 * which cancel it is the Workflow Builder's declaration on the Lifecycle Node,
 * per workflow, so the Event Author supplies vocabulary and nothing else
 * (ADR-0007).
 *
 * `defineEvent` registers nothing. It returns a plain value the host passes to
 * `createWfGraphApp`, which assembles the one catalog the editor reads.
 */

import { Effect, Schema } from "effect";
import { uniq } from "es-toolkit/array";
import {
  type InngestEventOptions,
  rewriteInngestOptions,
} from "#src/backend/extensions/inngest-options";
import type { JsonObject } from "@wfgraph/shared/types/json";
import type { StringPath } from "@wfgraph/shared/types/payload-path";
import {
  formatSchemaFailure,
  formatStandardIssuePath,
} from "@wfgraph/shared/types/schema-message";
import {
  asStandardSchema,
  isEffectSchema,
  type StandardSchema,
} from "@wfgraph/shared/types/schema";
import type { ReferenceField } from "@wfgraph/shared/graph/node-references";
import { compileEventDataEquals } from "@wfgraph/shared/lifecycle/inngest-event-data";
import { requireOutputFieldsFromSchema } from "@wfgraph/shared/graph/output-fields";
import { isSafeRecordPath } from "@wfgraph/shared/types/record-key";

/**
 * What an Event's payload schema may be written in: any Standard Schema library,
 * or a bare Effect schema, which is bridged here rather than by its author.
 *
 * Both halves of Standard Schema are needed from one object. The validate half
 * checks an arriving payload; the JSON Schema half is where `payloadFields`
 * comes from, so a library that describes only how to validate cannot define an
 * Event. Zod and arktype each publish both.
 *
 * `TPayload` is an Effect schema's **encoded** side, which is the payload as it
 * arrives and the shape every path in an Event definition addresses. A schema may
 * therefore carry a transform: a codec reading an ISO string into a `Date` still
 * declares a JSON payload, and the Correlation Path still names the string on the
 * wire.
 * Nothing consumes the decoded value -- the gate discards it and the raw JSON
 * travels -- so a transform buys validation precision and derivation, and the
 * decoded type it produces has no reader to serve. `OutputSchema` in
 * `@wfgraph/shared/graph/output-fields` is the deliberate opposite: an action's
 * handler produces the decoded value, so that one constrains the decoded side.
 *
 * The foreign arm names the other side, and Standard Schema leaves no way to say
 * otherwise: it publishes one output type, so a Zod or arktype schema's
 * `TPayload` is what that library validates *to*. It agrees with the wire for the
 * schemas anyone writes here, and diverges for a JSON-to-JSON morph -- an arktype
 * pipe renaming a key, say -- whose paths would then address a shape no sender
 * ever posts. An Event wanting a transform is written in Effect Schema.
 */
export type PayloadSchema<TPayload> =
  // The positions are `<Type, Encoded, DecodingServices, EncodingServices>`.
  // `never` in the decoding-services slot is what keeps this assignable to the
  // decode-side APIs that `Schema.ConstraintDecoder<unknown>` names, which is how
  // `asStandardSchema` and the gate's direct decode still accept it.
  // `Schema.ConstraintEncoder<TPayload>` names the encoded side too and is not a
  // substitute: it fills that slot with `unknown`, and no decode would take it.
  | StandardSchema<TPayload>
  | Schema.ConstraintCodec<unknown, TPayload, never, unknown>;

/** How an Event arrives, when the transport differs from the Event's identity. */
export type EventSource = {
  readonly event: string;
  readonly when?: { readonly path: string; readonly equals: string };
};

export type EventDefinition<TPayload extends JsonObject> = {
  readonly kind: "event";
  /** The Event's identity in Workflow Graph, and by default the name it arrives under. */
  readonly name: string;
  readonly label: string;
  readonly description?: string | undefined;
  /**
   * The intake gate: whether an arriving payload is this Event at all.
   *
   * Built from the author's Effect schema with Workflow Graph's own parse options when
   * there is one, and from `~standard.validate` when the payload was written in
   * Zod or arktype, so intake has one thing to call and one failure to catch.
   */
  readonly decodePayload: (
    payload: unknown
  ) => Effect.Effect<void, PayloadRejected>;
  /**
   * Where this payload carries its Entity Value.
   *
   * Optional, because an imported Event may have no path its author knew to
   * declare, and the Workflow Builder then supplies one in the Lifecycle panel.
   */
  readonly correlationPath?: string | undefined;
  readonly source: EventSource;
  /**
   * The authored flow control in the form Inngest's `createFunction` takes, as
   * `rewriteInngestOptions` translates it. The authored form is not kept, because
   * nothing downstream has a use for a path Inngest would reject.
   */
  readonly inngestFunctionOptions?: Record<string, unknown> | undefined;
  /** Derived once, at definition. What the editor lists. */
  readonly payloadFields: readonly ReferenceField[];
  /**
   * Phantom, and the only occurrence of `TPayload` left on this type.
   *
   * The type parameter earns its keep at the `defineEvent` call site rather than
   * here: it is what types `correlationPath`, `source.when.path`, and the Inngest
   * options against the payload's own shape. Without this field TypeScript would
   * have no occurrence to infer from and every definition would widen.
   */
  readonly _payload?: TPayload | undefined;
};

/** An Event definition of any payload, which is what a list of them holds. */
export type AnyEventDefinition = EventDefinition<JsonObject>;

/**
 * A payload that is not the Event it arrived as.
 *
 * One type at the seam whichever library described the payload, so the HTTP
 * route turns it into a 400 and the Inngest listener logs it and answers without
 * retrying: a malformed payload does not improve on a second attempt.
 *
 * Two strings for two audiences. `error` travels to the sender, which is a third
 * party across origins, so it names paths and expectations and quotes nothing of
 * what arrived. `detail` stays in the process, which is what lets it carry a
 * foreign library's own messages for the operator. An Effect payload schema
 * renders both through `formatSchemaFailure`, so the two read alike there.
 */
export class PayloadRejected extends Schema.TaggedError<PayloadRejected>()(
  "PayloadRejected",
  {
    eventName: Schema.String,
    error: Schema.String,
    detail: Schema.String,
  }
) {}

/**
 * The intake gate for one Event, built once at definition.
 *
 * Two decisions are deliberate and both are the design's (section 2.3).
 *
 * The gate is **open**: declared fields are validated and a key the schema never
 * heard of is ignored rather than refused. An Event's payload is the host's own
 * message, senders add fields routinely, and an additive change upstream must not
 * stop intake. This is the one boundary in the repo that does not carry
 * `rejectUnknownKeys`, and the consequence is worth stating: drift on a declared
 * field fails loudly, drift by addition is silent by choice.
 *
 * What it decodes to is **discarded**. Nothing downstream of an Event consumes a
 * typed value: the lifecycle reads a string at the Correlation Path, a wait match
 * evaluates CEL over JSON, templates resolve strings, and JSONB holds JSON. So the
 * raw payload is what travels, and a schema carrying a transform cannot rewrite
 * it on the way through -- a `Date` round trip would hand a run
 * `"2026-03-01T10:00:00.000Z"` where the sender wrote `"2026-03-01T10:00:00Z"`,
 * which is enough to break a wait match comparing a literal captured at park time.
 */
function buildPayloadGate(
  eventName: string,
  authored: PayloadSchema<unknown>,
  bridged: StandardSchema<unknown>
): (payload: unknown) => Effect.Effect<void, PayloadRejected> {
  const reject = (error: string, detail: string = error) =>
    Effect.fail(new PayloadRejected({ eventName, error, detail }));

  // An Effect schema is decoded directly for the message rather than for the
  // options: the bridge's defaults are these defaults, but `~standard.validate`
  // hands back strings it rendered itself, which spell out the shape of every
  // arm a union offered. A direct decode keeps the Effect issue, which this
  // project renders to a line of its own. The sender and the operator read the
  // same string here, because neither carries the payload.
  if (isEffectSchema(authored)) {
    const decode = Schema.decodeUnknownEffect(authored, { errors: "all" });
    return (payload) =>
      decode(payload).pipe(
        Effect.asVoid,
        Effect.catchTag("SchemaError", (failure) =>
          reject(formatSchemaFailure(failure.issue))
        )
      );
  }

  // A foreign library's own validate, whose messages are its own. The answer is
  // joined by path rather than passed through whole, because a library free to
  // quote the value it rejected would put a payload in the reply. The
  // operator's string keeps each library's own message, because it never leaves
  // the process.
  return (payload) =>
    Effect.suspend<void, PayloadRejected, never>(() => {
      const result = bridged["~standard"].validate(payload);

      if (result instanceof Promise) {
        return reject(
          "This Event's payload schema validates asynchronously, which intake cannot use"
        );
      }

      if (!result.issues) {
        return Effect.void;
      }

      const paths = uniq(
        result.issues.map((issue) => formatStandardIssuePath(issue.path))
      ).join(", ");
      const detail = result.issues
        .map(
          (issue) => `${formatStandardIssuePath(issue.path)}: ${issue.message}`
        )
        .join("; ");
      return reject(
        `Payload does not fit this Event at: ${paths}`,
        `Payload does not fit this Event: ${detail}`
      );
    });
}

export type DefineEventInput<TPayload extends JsonObject> = {
  /**
   * The Event's identity in Workflow Graph. One Event per name, and per thing that
   * happened: an app declares `appointment.created` and `appointment.canceled`
   * separately rather than one umbrella Event with a subtype field, because the
   * lifecycle model's rules are stated over Event names.
   */
  readonly name: string;
  /** Defaults to the name. */
  readonly label?: string | undefined;
  readonly description?: string | undefined;
  readonly schema: PayloadSchema<TPayload>;
  /**
   * Where the payload carries its Entity Value. An Entity Value is a string, so
   * only a path resolving to one is admitted.
   */
  readonly correlationPath?: StringPath<TPayload> | undefined;
  /**
   * How the Event arrives, for an existing bus that sends one umbrella name and
   * cannot change. Identity stays the Workflow Graph name above, so the lifecycle model is
   * untouched, and `when` becomes the listener's filter so Inngest still does
   * the narrowing.
   *
   * Defaults to `{ event: name }`.
   */
  readonly source?:
    | {
        readonly event: string;
        readonly when?: {
          readonly path: StringPath<TPayload>;
          readonly equals: string;
        };
      }
    | undefined;
  readonly inngest?: InngestEventOptions<TPayload> | undefined;
};

/**
 * Define an Event.
 *
 * The schema crosses the Standard Schema bridge here, once, and `payloadFields`
 * is derived from it on the spot: an Event's field list is fixed the moment it is
 * defined, so nothing later derives it again or holds a hand-written copy.
 *
 * A description annotation is decoration: the editor shows that text beside the
 * path and falls back to the title-cased key. A schema the derivation cannot
 * read at all throws here naming the Event.
 */
export function defineEvent<TPayload extends JsonObject>(
  input: DefineEventInput<TPayload>
): EventDefinition<TPayload> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("An Event's name must be a non-empty string");
  }

  const label = input.label?.trim() || name;

  // The one place a payload schema is bridged, so the parse options a decode
  // would carry are decided once and by this call. The gate beside it is built
  // from the authored schema for the same reason: those frozen options are not
  // the ones an intake decode wants.
  const schema = asStandardSchema(input.schema);

  const sourceEvent = input.source?.event.trim() || name;
  const when = input.source?.when;
  const correlationPath = input.correlationPath?.trim() || undefined;

  if (correlationPath && !isSafeRecordPath(correlationPath)) {
    throw new Error(
      `Event "${name}" declares a correlation path containing a key reserved by JavaScript objects.`
    );
  }
  if (when && !isSafeRecordPath(when.path)) {
    throw new Error(
      `Event "${name}" declares a source filter path containing a key reserved by JavaScript objects.`
    );
  }

  // Compiled here rather than where the listener is built, so a filter that
  // cannot become a CEL expression fails at definition, in the build of whoever
  // wrote it.
  if (when) {
    compileEventDataEquals(when);
  }

  const inngestFunctionOptions = input.inngest
    ? rewriteInngestOptions(name, input.inngest, schema)
    : undefined;

  return {
    kind: "event",
    name,
    label,
    description: input.description,
    decodePayload: buildPayloadGate(name, input.schema, schema),
    correlationPath,
    source: when ? { event: sourceEvent, when } : { event: sourceEvent },
    inngestFunctionOptions,
    payloadFields: requireOutputFieldsFromSchema(`Event "${name}"`, schema),
  };
}
