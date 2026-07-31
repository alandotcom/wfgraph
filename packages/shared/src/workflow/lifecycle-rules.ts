/**
 * The Lifecycle Rules: the Workflow Builder's per-workflow declaration of a
 * run's lifetime (ADR-0007). They live on the entry node's config, so this
 * module owns their shape and the sentences a save is refused with.
 *
 * An Event carries no lifecycle role. The same Event starts one workflow,
 * cancels another, and only wakes a wait in a third, which is why the roles are
 * named here rather than by the Event Author.
 */

import { Schema } from "effect";
import { compact } from "es-toolkit/array";
import { type ExtensionCatalog, findEvent } from "#src/extensions/catalog";
import { NonEmptyTrimmedString, readAs } from "#src/types/schema";

/**
 * How many Executions may exist per Entity Value.
 *
 * Rova's own rather than Inngest's: newest-wins has to end the displaced run
 * with a status, and first-wins has to refuse a start and say so in run
 * history. Inngest concurrency can do neither.
 */
const concurrencySchema = Schema.Literals([
  "newest-wins",
  "first-wins",
  "unlimited",
]);

export type Concurrency = typeof concurrencySchema.Type;

export const lifecycleRulesSchema = Schema.Struct({
  /**
   * The Event that starts a run, absent when no Event does.
   *
   * One rather than a list, because everything downstream of the entry node is
   * written against the payload that started the run: a second Start Event would
   * mean a builder addressing only the fields the two happen to share.
   */
  startEvent: Schema.optional(NonEmptyTrimmedString),
  /** Event names that route in-flight runs to the Canceled outlet. */
  cancelEvents: Schema.Array(NonEmptyTrimmedString),
  concurrency: concurrencySchema,

  /**
   * The start source that is not an Event: the Run button and the execute route.
   *
   * A clock is the other one the design names, and it is absent rather than
   * carried-and-refused, because nothing in Rova can write one. It arrives with
   * whatever ticks it, and the panel says so where a builder looks for it.
   */
  allowManualStart: Schema.optional(Schema.Boolean),

  /**
   * A Correlation Path the builder supplied for an Event whose definition
   * declares none. Keyed by Event name.
   */
  correlationPaths: Schema.optional(
    Schema.Record(Schema.String, NonEmptyTrimmedString)
  ),
});

export type LifecycleRules = typeof lifecycleRulesSchema.Type;

/**
 * What the delivery path reads a rules-less graph as: no Event starts it.
 *
 * Read by `applyLifecycleRules`, so that an Event still reaches the waits of runs
 * parked inside such a graph -- an empty declaration rather than a reason to skip
 * the workflow. It says nothing about manual starts, because the question the
 * delivery path asks is only which Events start a run; `manualStartAllowed` is
 * what answers the other one.
 */
export const emptyLifecycleRules: LifecycleRules = {
  cancelEvents: [],
  concurrency: "unlimited",
};

/**
 * What the panel offers a graph that has never had rules.
 *
 * Read by the Lifecycle panel and by the canvas summary beside it. Manual starts
 * are on, which is the whole of the delta: the moment rules exist they are held to
 * the start-source rule, so rules written with no Start Event yet would refuse the
 * save that wrote them, and a workflow carrying no rules is one the Run button
 * already starts.
 */
export const initialLifecycleRules: LifecycleRules = {
  ...emptyLifecycleRules,
  allowManualStart: true,
};

const readRules = readAs(lifecycleRulesSchema);

/**
 * The rules off an entry node's config, or undefined when it carries none.
 *
 * Strictness lives in the graph schema, which decodes this shape as part of the
 * node it sits on; a value reaching here has already been through it.
 */
export function readLifecycleRules(
  config: Record<string, unknown> | undefined
): LifecycleRules | undefined {
  return readRules(config?.lifecycleRules);
}

/**
 * Where an Event's Entity Value sits for this workflow: the Event Author's path,
 * or the one the builder supplied for an Event that declares none.
 */
export function resolveCorrelationPath(input: {
  rules: LifecycleRules;
  eventName: string;
  declaredPath?: string;
}): string | undefined {
  return input.declaredPath ?? input.rules.correlationPaths?.[input.eventName];
}

/** Whether anything at all can start a run of this workflow. */
export function hasStartSource(rules: LifecycleRules): boolean {
  return rules.startEvent !== undefined || rules.allowManualStart === true;
}

/**
 * Whether the Run button and the execute route may start this workflow.
 *
 * Absent rules mean yes: a graph the Lifecycle panel has never been near is one
 * the Run button is how anybody tries. Rules that exist and leave manual starts
 * out are a decision, and taking `undefined` here is what keeps that distinction
 * in one place instead of at each call site.
 */
export function manualStartAllowed(rules: LifecycleRules | undefined): boolean {
  return rules === undefined || rules.allowManualStart === true;
}

export type LifecycleRulesCheck =
  | { valid: true }
  | { valid: false; error: string };

const valid: LifecycleRulesCheck = { valid: true };

const refuse = (error: string): LifecycleRulesCheck => ({
  valid: false,
  error,
});

/**
 * The sentence a save is refused with when a name resolves to no Event.
 *
 * Exported so the wait check in `workflow-lifecycle-validation.ts` shares this
 * copy rather than wording the same refusal a second time.
 */
export function unknownEventMessage(name: string): string {
  return `No Event named "${name}" is defined. Choose an Event this app declares, or ask whoever defines them to add it.`;
}

/** Which node is asking a builder for an Event's Correlation Path. */
export type CorrelationPathRole = "start" | "cancel";

export type CorrelationPathRequest = {
  eventName: string;
  role: CorrelationPathRole;
  /** What the builder has supplied so far, absent while the path is still owed. */
  suppliedPath?: string;
};

/**
 * The Events this workflow matches by Entity Value whose author declared no path,
 * so the builder is the one being asked.
 *
 * A cancel always matches by entity, and a start does once Concurrency compares,
 * which is why an unlimited workflow may start on a correlation-free Event. A wait
 * is not here: a Wait Subscription carries its own match expression, so what an
 * arriving payload is compared against is stated on the Wait node itself.
 *
 * A member whose `suppliedPath` is set is answered, not absent: the panel renders an
 * input per member so a path can be corrected or cleared, and the save refuses on
 * the first member still owing one. Filtering the set itself down to the unanswered
 * ones would make the input vanish the moment it was filled in.
 */
export function eventsNeedingCorrelationPath(input: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
}): CorrelationPathRequest[] {
  const { rules, catalog } = input;

  const matchByEntityValue: Array<{
    eventName: string;
    role: CorrelationPathRole;
  }> = [
    ...(rules.concurrency === "unlimited" || rules.startEvent === undefined
      ? []
      : [{ eventName: rules.startEvent, role: "start" as const }]),
    ...rules.cancelEvents.map((eventName) => ({
      eventName,
      role: "cancel" as const,
    })),
  ];

  const seen = new Set<string>();
  const requests: CorrelationPathRequest[] = [];

  for (const entry of matchByEntityValue) {
    if (
      seen.has(entry.eventName) ||
      findEvent(catalog, entry.eventName)?.correlationPath
    ) {
      continue;
    }
    seen.add(entry.eventName);

    requests.push({
      ...entry,
      suppliedPath: rules.correlationPaths?.[entry.eventName],
    });
  }

  return requests;
}

/**
 * What a save is held to, as sentences a builder can be shown.
 *
 * The catalog is the vocabulary these rules are checked against, so a workflow
 * naming an Event the app no longer defines is refused where it is saved rather
 * than going quiet at delivery time.
 */
export function checkLifecycleRules(input: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
}): LifecycleRulesCheck {
  const { rules, catalog } = input;

  // ADR-0007 rejects one Event holding both roles rather than picking a winner.
  if (rules.startEvent && rules.cancelEvents.includes(rules.startEvent)) {
    return refuse(
      `Event "${rules.startEvent}" cannot both start and cancel runs of this workflow. Give it one role, or start on one Event and cancel on another.`
    );
  }

  const named = compact([rules.startEvent, ...rules.cancelEvents]);
  for (const name of named) {
    if (!findEvent(catalog, name)) {
      return refuse(unknownEventMessage(name));
    }
  }

  const owed = eventsNeedingCorrelationPath({ rules, catalog }).find(
    (request) => !request.suppliedPath
  );
  if (owed) {
    return refuse(missingCorrelationPathMessage(owed.eventName));
  }

  if (!hasStartSource(rules)) {
    return refuse(
      "Nothing can start this workflow. Add a Start Event, or allow manual starts."
    );
  }

  return valid;
}

/**
 * The gap where the Event Author and the Workflow Builder meet, worded so the
 * panel says which side owns it.
 */
function missingCorrelationPathMessage(eventName: string): string {
  return `Event "${eventName}" declares no Correlation Path. Enter the payload path holding the value that identifies the entity, or ask whoever defined the Event to declare it.`;
}
