/**
 * An Event: a name, a payload shape, and the host-owned Entities that payload
 * can identify.
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
import type { AnyEntityDefinition } from "#src/backend/extensions/define-entity";
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
import {
  isSafeRecordKey,
  isSafeRecordPath,
} from "@wfgraph/shared/types/record-key";

/**
 * What an Event's payload schema may be written in: any Standard Schema library,
 * or a bare Effect schema, which is bridged here rather than by its author.
 *
 * Both halves of Standard Schema are needed from one object. The validate half
 * checks an arriving payload; the JSON Schema half is where `payloadFields`
 * comes from, so a library that describes only how to validate cannot define an
 * Event. Zod and arktype each publish both.
 *
 * `TPayload` is the schema's input or encoded side: the JSON payload as it
 * arrives and the shape every path in an Event definition addresses.
 * `TValidated` is the decoded output passed to Entity ID selectors. A codec may
 * therefore read an ISO string into a `Date` for a selector while the Correlation
 * Path and the workflow continue to see the original wire string.
 */
export type PayloadSchema<TPayload extends JsonObject, TValidated> =
  // The positions are `<Type, Encoded, DecodingServices, EncodingServices>`.
  // `never` in the decoding-services slot is what keeps this assignable to the
  // decode-side APIs that `Schema.ConstraintDecoder<unknown>` names, which is how
  // `asStandardSchema` and the gate's direct decode still accept it.
  // The encoded side is the JSON payload that travels through the workflow; the
  // decoded side is what an Entity ID selector receives.
  | StandardSchema<TValidated, TPayload>
  | Schema.ConstraintCodec<TValidated, TPayload, never, unknown>;

/** How an Event arrives, when the transport differs from the Event's identity. */
export type EventSource = {
  readonly event: string;
  readonly when?:
    | { readonly path: string; readonly equals: string }
    | undefined;
};

export type EventEntityBinding<TValidated> = {
  readonly entity: AnyEntityDefinition;
  selectEntityId(event: TValidated): string;
};

export type EventDefinition<
  TPayload extends JsonObject,
  TValidated = TPayload,
> = {
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
  /** The validated representation an Entity ID selector reads. */
  readonly decodePayloadValue: (
    payload: unknown
  ) => Effect.Effect<TValidated, PayloadRejected>;
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
  /** Named ways this Event identifies host-owned Entities. */
  readonly entities?:
    | Readonly<Record<string, EventEntityBinding<TValidated>>>
    | undefined;
  /**
   * Phantom, and the only occurrence of `TPayload` left on this type.
   *
   * The type parameter earns its keep at the `defineEvent` call site rather than
   * here: it is what types `correlationPath`, `source.when.path`, and the Inngest
   * options against the payload's own shape. Without this field TypeScript would
   * have no occurrence to infer from and every definition would widen.
   */
  readonly _payload?: TPayload | undefined;
  readonly _validatedPayload?: TValidated | undefined;
};

/** An Event definition of any payload, which is what a list of them holds. */
export type AnyEventDefinition = EventDefinition<JsonObject, unknown>;

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
 * The decoded value exists only for an Entity ID selector. The raw payload still
 * travels through lifecycle filters, waits, templates, and persistence, so a
 * transform cannot rewrite Event data on the way through. A `Date` produced for
 * a selector therefore does not replace the sender's original timestamp string.
 */
function buildPayloadGate<TPayload extends JsonObject, TValidated>(
  eventName: string,
  authored: PayloadSchema<TPayload, TValidated>,
  bridged: StandardSchema<TValidated, TPayload>
): (payload: unknown) => Effect.Effect<TValidated, PayloadRejected> {
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
    Effect.suspend<TValidated, PayloadRejected, never>(() => {
      const result = bridged["~standard"].validate(payload);

      if (result instanceof Promise) {
        return reject(
          "This Event's payload schema validates asynchronously, which intake cannot use"
        );
      }

      if (!result.issues) {
        return Effect.succeed(result.value);
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

function normalizeEntityBindings<TValidated>(
  eventName: string,
  bindings:
    | Readonly<
        Record<
          string,
          {
            readonly entity: AnyEntityDefinition;
            readonly selectEntityId: (event: NoInfer<TValidated>) => string;
          }
        >
      >
    | undefined
): Readonly<Record<string, EventEntityBinding<TValidated>>> | undefined {
  if (!bindings) {
    return undefined;
  }

  const normalized = new Map<string, EventEntityBinding<TValidated>>();
  for (const [authoredName, binding] of Object.entries(bindings)) {
    const name = authoredName.trim();
    if (!name) {
      throw new Error(
        `Event "${eventName}" declares a blank Entity binding name`
      );
    }
    if (!isSafeRecordKey(name)) {
      throw new Error(
        `Event "${eventName}" declares an Entity binding name reserved by JavaScript objects.`
      );
    }
    if (normalized.has(name)) {
      throw new Error(
        `Event "${eventName}" declares more than one Entity binding named "${name}".`
      );
    }

    normalized.set(name, {
      entity: binding.entity,
      selectEntityId: (event) => {
        const selected = binding.selectEntityId(event);
        if (typeof selected !== "string" || selected.trim().length === 0) {
          throw new Error(
            `Event "${eventName}" Entity binding "${name}" must select a non-empty string Entity ID.`
          );
        }
        return selected.trim();
      },
    });
  }

  return normalized.size === 0
    ? undefined
    : Object.fromEntries(normalized.entries());
}

export type DefineEventInput<
  TPayload extends JsonObject,
  TValidated = TPayload,
> = {
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
  readonly schema: PayloadSchema<TPayload, TValidated>;
  /** Named Entity identities this Event can establish for a workflow. */
  readonly entities?:
    | Readonly<
        Record<
          string,
          {
            readonly entity: AnyEntityDefinition;
            readonly selectEntityId: (event: NoInfer<TValidated>) => string;
          }
        >
      >
    | undefined;
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
        readonly when?:
          | {
              readonly path: StringPath<TPayload>;
              readonly equals: string;
            }
          | undefined;
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
export function defineEvent<TPayload extends JsonObject, TValidated = TPayload>(
  input: DefineEventInput<TPayload, TValidated>
): EventDefinition<TPayload, TValidated> {
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

  const decodePayloadValue = buildPayloadGate(name, input.schema, schema);
  const entities = normalizeEntityBindings<TValidated>(name, input.entities);

  return {
    kind: "event",
    name,
    label,
    description: input.description,
    decodePayload: (payload) => decodePayloadValue(payload).pipe(Effect.asVoid),
    decodePayloadValue,
    correlationPath,
    source: when ? { event: sourceEvent, when } : { event: sourceEvent },
    inngestFunctionOptions,
    payloadFields: requireOutputFieldsFromSchema(`Event "${name}"`, schema),
    entities,
  };
}
