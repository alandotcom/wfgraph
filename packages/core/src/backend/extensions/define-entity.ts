/**
 * A host-owned Entity type and the current state Workflow Graph may inspect.
 *
 * The host remains the system of record. A definition carries one live resolver
 * and a schema for the point-in-time state it returns; assembly later exposes
 * only the serializable identity and field metadata to the editor.
 */

import { createHash } from "node:crypto";
import { Result, Schema } from "effect";
import { sortBy } from "es-toolkit/array";
import {
  encodeThroughOutputSchema,
  validateThroughOutputSchema,
} from "#src/backend/extensions/steps/output-encoding";
import {
  asStandardSchema,
  isEffectSchema,
  type StandardSchema,
} from "@wfgraph/shared/types/schema";
import { type JsonObject, readJsonObject } from "@wfgraph/shared/types/json";
import { jsonSchemaLibraryOptions } from "@wfgraph/shared/graph/schema-codec";
import { requireOutputFieldsFromSchema } from "@wfgraph/shared/graph/output-fields";
import type { ReferenceField } from "@wfgraph/shared/graph/node-references";

/**
 * A schema for the decoded state a resolver returns.
 *
 * Effect carries an encoder and may transform decoded state into JSON. Standard
 * Schema exposes validation only, so its input and output must be the same
 * object type: the resolver returns that value and validation may sanitize it.
 */
export type EntityStateSchema<TState extends object> =
  | StandardSchema<TState, TState>
  | Schema.ConstraintCodec<TState, unknown>;

export type EntityResolver<TState extends object> = (input: {
  readonly entityId: string;
}) => TState | null | Promise<TState | null>;

export type DefineEntityInput<TState extends object> = {
  /** Stable serialized identifier for this Entity type. */
  readonly type: string;
  /** Human-readable name shown to Workflow Builders. */
  readonly label: string;
  /** Shape of the current state Workflow Builders may filter. */
  readonly state: EntityStateSchema<TState>;
  /** Reads current host state for one Entity instance. */
  readonly resolve: EntityResolver<NoInfer<TState>>;
};

export type EntityDefinition<TState extends object> = {
  readonly kind: "entity";
  readonly type: string;
  readonly label: string;
  readonly stateFields: readonly ReferenceField[];
  readonly stateSchemaDigest: string;
  /**
   * Resolves, validates and JSON-encodes current state without persisting it.
   * `null` is the explicit missing-Entity result.
   */
  readonly resolve: (input: {
    readonly entityId: string;
  }) => Promise<JsonObject | null>;
  /** Keeps the schema-derived resolver type attached to this definition. */
  readonly _state?: TState | undefined;
};

export type AnyEntityDefinition = EntityDefinition<object>;

/** A resolver returned state that its declared schema cannot safely expose. */
export class EntityStateRejected extends Error {
  readonly entityType: string;

  constructor(entityType: string, detail: string) {
    super(detail);
    this.name = "EntityStateRejected";
    this.entityType = entityType;
  }
}

function canonicalJson(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJson(item));
    return key === "required" && items.every((item) => typeof item === "string")
      ? items.toSorted()
      : items;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    sortBy(Object.entries(value), [([entryKey]) => entryKey]).map(
      ([entryKey, item]) => [entryKey, canonicalJson(item, entryKey)]
    )
  );
}

function schemaDigest(schema: StandardSchema<unknown>): string {
  const jsonSchema = schema["~standard"].jsonSchema.input({
    target: "draft-2020-12",
    libraryOptions: jsonSchemaLibraryOptions,
  });

  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(jsonSchema)))
    .digest("hex");
}

// A schema failure's path can name a key straight out of the host's data, for
// example a record keyed by an email address. `EntityStateRejected` reaches
// persisted run failures and HTTP answers, so this message stays generic:
// it names the Entity type and nothing from the rejected state.
function invalidState(entityType: string): EntityStateRejected {
  return new EntityStateRejected(
    entityType,
    `Entity "${entityType}" returned current state its schema does not accept.`
  );
}

function invalidStateShape(
  entityType: string,
  detail: string
): EntityStateRejected {
  return new EntityStateRejected(
    entityType,
    `Entity "${entityType}" returned current state its schema does not accept: ${detail}`
  );
}

function buildStateReader<TState extends object>(
  entityType: string,
  authored: EntityStateSchema<TState>,
  bridged: StandardSchema<TState>
): (value: TState) => JsonObject {
  const subject = `Entity "${entityType}"`;
  const read = isEffectSchema<TState, never>(authored)
    ? encodeThroughOutputSchema(subject, authored)
    : validateThroughOutputSchema(subject, bridged);

  return (value) => {
    const result = read(value);
    if (Result.isFailure(result)) {
      throw invalidState(entityType);
    }

    const state = readJsonObject(result.success);
    if (state === null) {
      throw invalidStateShape(
        entityType,
        "the encoded state is not a JSON object"
      );
    }
    return state;
  };
}

/**
 * Defines one reusable host-owned Entity type.
 *
 * The schema is the sole inference source for resolver output. Effect schemas
 * encode through their canonical JSON codec; foreign Standard Schemas validate
 * and return their parsed value. Both paths then require a JSON object root.
 */
export function defineEntity<TState extends object>(
  input: DefineEntityInput<TState>
): EntityDefinition<TState> {
  const type = input.type.trim();
  if (!type) {
    throw new Error("An Entity's type must be a non-empty string");
  }

  const label = input.label.trim();
  if (!label) {
    throw new Error(`Entity "${type}" must have a non-empty label`);
  }

  const state = asStandardSchema(input.state);
  const stateFields = requireOutputFieldsFromSchema(
    `Entity "${type}" state`,
    state
  );
  const readState = buildStateReader(type, input.state, state);

  return {
    kind: "entity",
    type,
    label,
    stateFields,
    stateSchemaDigest: schemaDigest(state),
    async resolve({ entityId }) {
      const resolved: TState | null = await input.resolve({ entityId });
      return resolved === null ? null : readState(resolved);
    },
  };
}
