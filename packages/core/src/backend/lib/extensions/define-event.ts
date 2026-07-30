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
 * `createRovaApp`, which assembles the one catalog the editor reads.
 */

import type { Schema } from "effect";
import {
  type InngestEventOptions,
  rewriteInngestOptions,
} from "#src/backend/lib/extensions/inngest-options";
import type { JsonObject } from "@rova/shared/types/json";
import type { StringPath } from "@rova/shared/types/payload-path";
import {
  asStandardSchema,
  type StandardSchema,
} from "@rova/shared/types/schema";
import type { ReferenceField } from "@rova/shared/workflow/node-references";
import { requireOutputFieldsFromSchema } from "@rova/shared/workflow/output-fields";

/**
 * What an Event's payload schema may be written in: any Standard Schema library,
 * or a bare Effect schema, which is bridged here rather than by its author.
 *
 * Both halves of Standard Schema are needed from one object. The validate half
 * checks an arriving payload; the JSON Schema half is where `payloadFields`
 * comes from, so a library that describes only how to validate cannot define an
 * Event. Zod and arktype each publish both.
 */
export type PayloadSchema<TPayload> =
  | StandardSchema<TPayload>
  | Schema.ConstraintDecoder<TPayload>;

/** How an Event arrives, when the transport differs from the Event's identity. */
export type EventSource = {
  readonly event: string;
  readonly when?: { readonly path: string; readonly equals: string };
};

export type EventDefinition<TPayload extends JsonObject> = {
  readonly kind: "event";
  /** The Event's identity in Rova, and by default the name it arrives under. */
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  readonly schema: StandardSchema<TPayload>;
  /**
   * Where this payload carries its Entity Value.
   *
   * Optional, because an imported Event may have no path its author knew to
   * declare, and the Workflow Builder then supplies one in the Lifecycle panel.
   */
  readonly correlationPath?: string;
  readonly source: EventSource;
  /**
   * The authored flow control in the form Inngest's `createFunction` takes, as
   * `rewriteInngestOptions` translates it. The authored form is not kept, because
   * nothing downstream has a use for a path Inngest would reject.
   */
  readonly inngestFunctionOptions?: Record<string, unknown>;
  /** Derived once, at definition. What the editor lists. */
  readonly payloadFields: readonly ReferenceField[];
  /** Phantom, so the payload type stays inferable at a call site. */
  readonly _payload?: TPayload;
};

/** An Event definition of any payload, which is what a list of them holds. */
export type AnyEventDefinition = EventDefinition<JsonObject>;

export type DefineEventInput<TPayload extends JsonObject> = {
  /**
   * The Event's identity in Rova. One Event per name, and per thing that
   * happened: an app declares `appointment.created` and `appointment.canceled`
   * separately rather than one umbrella Event with a subtype field, because the
   * lifecycle model's rules are stated over Event names.
   */
  readonly name: string;
  /** Defaults to the name. */
  readonly label?: string;
  readonly description?: string;
  readonly schema: PayloadSchema<TPayload>;
  /**
   * Where the payload carries its Entity Value. An Entity Value is a string, so
   * only a path resolving to one is admitted.
   */
  readonly correlationPath?: StringPath<TPayload>;
  /**
   * How the Event arrives, for an existing bus that sends one umbrella name and
   * cannot change. Identity stays the Rova name above, so the lifecycle model is
   * untouched, and `when` becomes the listener's filter so Inngest still does
   * the narrowing.
   *
   * Defaults to `{ event: name }`.
   */
  readonly source?: {
    readonly event: string;
    readonly when?: {
      readonly path: StringPath<TPayload>;
      readonly equals: string;
    };
  };
  readonly inngest?: InngestEventOptions<TPayload>;
};

/**
 * Define an Event.
 *
 * The schema crosses the Standard Schema bridge here, once, and `payloadFields`
 * is derived from it on the spot: an Event's field list is fixed the moment it is
 * defined, so nothing later derives it again or holds a hand-written copy.
 *
 * Every payload path needs a description annotation, nested objects included,
 * because the editor shows that text beside the path. A bare field throws here
 * naming the Event.
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
  // would carry are decided once and by this call.
  const schema = asStandardSchema(input.schema);

  const sourceEvent = input.source?.event.trim() || name;
  const when = input.source?.when;

  const inngestFunctionOptions = input.inngest
    ? rewriteInngestOptions(name, input.inngest, schema)
    : undefined;

  return {
    kind: "event",
    name,
    label,
    description: input.description,
    schema,
    correlationPath: input.correlationPath?.trim() || undefined,
    source: when ? { event: sourceEvent, when } : { event: sourceEvent },
    inngestFunctionOptions,
    payloadFields: requireOutputFieldsFromSchema(`Event "${name}"`, schema),
  };
}
