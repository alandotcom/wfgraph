/**
 * The test-run form, derived from one Event's declared payload.
 *
 * An Event names its own payload paths and their types, so the form a builder
 * fills is read off that declaration rather than written per Event. The form
 * holds every value as text and coerces on the way out, which keeps a
 * half-typed number from being a state the editor has to represent.
 *
 * The Event's own schema is the gate a payload passes, on the server. Nothing
 * here refuses a value: a field that will not coerce travels as the text it is
 * and comes back with the Event's own sentence about it.
 */

import type { EventMetadata } from "@wfgraph/shared/extensions/catalog";
import type { ReferenceField } from "@wfgraph/shared/graph/node-references";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  type LifecycleRules,
  readLifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import {
  readTestPayloads,
  type TestPayloads,
} from "@wfgraph/shared/lifecycle/test-payloads";
import {
  type JsonObject,
  type JsonValue,
  readJsonObject,
} from "@wfgraph/shared/types/json";
import { encodeIsoTimestamp } from "@wfgraph/shared/types/timestamp";
import {
  getValueByPath,
  setValueByPath,
} from "@wfgraph/shared/utils/object-path";

/** Which control draws a field, decided by the type the Event declared. */
export type TestPayloadControl =
  | "text"
  | "number"
  | "checkbox"
  | "datetime"
  | "select";

export type TestPayloadField = {
  path: string;
  description?: string;
  control: TestPayloadControl;
  /** The values a select offers, present only for `control: "select"`. */
  options?: string[];
  optional: boolean;
};

/** Every value the form holds, keyed by the path it addresses. */
export type TestPayloadFormValues = Record<string, string>;

/**
 * Whether the form can address this path.
 *
 * A path into an array carries a `[0]` suffix, and a container's own path names
 * an object or an array rather than a value to type. Both go to the JSON pane,
 * which is why the overlay offers one at all.
 */
function isFormAddressable(field: ReferenceField): boolean {
  if (field.path.includes("[")) {
    return false;
  }

  return field.type !== "array" && field.type !== "object";
}

function controlFor(field: ReferenceField): TestPayloadControl {
  if (field.enumValues && field.enumValues.length > 0) {
    return "select";
  }

  if (field.type === "boolean") {
    return "checkbox";
  }

  if (field.type === "number") {
    return "number";
  }

  return field.type === "timestamp" ? "datetime" : "text";
}

/** The fields the form draws for one Event, in the order the Event declares. */
export function testPayloadFields(
  event: EventMetadata | undefined
): TestPayloadField[] {
  if (!event) {
    return [];
  }

  return event.payloadFields.filter(isFormAddressable).map((field) => ({
    path: field.path,
    ...(field.description ? { description: field.description } : {}),
    control: controlFor(field),
    ...(field.enumValues ? { options: [...field.enumValues] } : {}),
    optional: field.nullable === true,
  }));
}

/**
 * What a `datetime-local` input shows, out of an ISO string.
 *
 * The input takes local wall-clock text with no zone, so the stored instant is
 * rendered in the browser's own zone and read back in it. Text that is not a
 * timestamp is handed back untouched, which is how a payload written in the JSON
 * pane survives a trip through the form.
 */
function toLocalDateTimeText(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  const offsetMs = parsed.getTimezoneOffset() * 60_000;
  return new Date(parsed.getTime() - offsetMs).toISOString().slice(0, 16);
}

/** The form's starting values, read out of a payload the workflow kept. */
export function formValuesFromPayload(
  fields: readonly TestPayloadField[],
  payload: JsonObject | undefined
): TestPayloadFormValues {
  const values: TestPayloadFormValues = {};

  for (const field of fields) {
    const stored = getValueByPath(payload, field.path);
    if (stored === undefined || stored === null) {
      values[field.path] = "";
      continue;
    }

    const text = typeof stored === "string" ? stored : JSON.stringify(stored);
    values[field.path] =
      field.control === "datetime" ? toLocalDateTimeText(text) : text;
  }

  return values;
}

/**
 * One typed value out of the text a control holds, or undefined where the field
 * was left blank. A blank field is an absent key rather than an empty string, so
 * an optional path stays absent and a required one is refused by the Event.
 */
function coerce(field: TestPayloadField, text: string): JsonValue | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  if (field.control === "checkbox") {
    return trimmed === "true";
  }

  if (field.control === "number") {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : trimmed;
  }

  if (field.control === "datetime") {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime())
      ? trimmed
      : encodeIsoTimestamp(parsed);
  }

  return trimmed;
}

/**
 * The payload the form describes, with each path nested where the Event declared
 * it. `base` carries whatever the JSON pane holds that the form has no field
 * for, so switching between the two panes loses nothing.
 */
export function payloadFromFormValues(
  fields: readonly TestPayloadField[],
  values: TestPayloadFormValues,
  base: JsonObject = {}
): JsonObject {
  const payload = structuredClone(base);

  for (const field of fields) {
    const value = coerce(field, values[field.path] ?? "");
    if (value !== undefined) {
      setValueByPath(payload, field.path, value);
    }
  }

  return payload;
}

/**
 * A payload read back out of the JSON pane. Anything that is not a JSON object
 * is a mistake the pane reports where it was typed, so the failure is a message
 * rather than a thrown error.
 */
export function parseTestPayload(
  text: string
): { ok: true; payload: JsonObject } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: true, payload: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "This is not valid JSON." };
  }

  const payload = readJsonObject(parsed);
  return payload
    ? { ok: true, payload }
    : { ok: false, error: "A payload has to be a JSON object." };
}

/** The entry node, which is where both the rules and the samples live. */
export function findEntryNode(
  nodes: readonly WorkflowNode[]
): WorkflowNode | undefined {
  return nodes.find((node) => node.data.type === "lifecycle");
}

export function readEntryLifecycleRules(
  nodes: readonly WorkflowNode[]
): LifecycleRules | undefined {
  return readLifecycleRules(findEntryNode(nodes)?.data.config);
}

export function readEntryTestPayloads(
  nodes: readonly WorkflowNode[]
): TestPayloads {
  return readTestPayloads(findEntryNode(nodes)?.data.config) ?? {};
}

/**
 * The samples with this run's payload written in, under the Event it names or
 * under the Event-less slot. The whole object is rewritten because the entry
 * node's config is replaced key by key, so a partial record would drop the
 * Events this run did not touch.
 */
export function nextTestPayloads(
  current: TestPayloads,
  request: { eventName?: string; input: JsonObject }
): TestPayloads {
  if (!request.eventName) {
    return { ...current, manual: request.input };
  }

  return {
    ...current,
    byEvent: { ...current.byEvent, [request.eventName]: request.input },
  };
}
