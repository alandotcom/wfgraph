/**
 * The Lifecycle Rules: the Workflow Builder's per-workflow declaration of a
 * run's lifetime (ADR-0007). They live on the entry node's config, so this
 * module owns their shape and the sentences a save is refused with.
 *
 * An Event carries no lifecycle role. The same Event starts one workflow,
 * cancels another, and only wakes a wait in a third, which is why the roles are
 * lists of Event names here rather than anything the Event Author writes.
 */

import { Schema } from "effect";
import { uniq } from "es-toolkit/array";
import { type ExtensionCatalog, findEvent } from "#src/extensions/catalog";
import { NonEmptyTrimmedString, readAs } from "#src/types/schema";

/**
 * How many Executions may exist per Entity Value.
 *
 * Rova's own rather than Inngest's: newest-wins has to end the displaced run
 * with a status, and first-wins has to refuse a start and say so in run
 * history. Inngest concurrency can do neither.
 */
export const concurrencySchema = Schema.Literals([
  "newest-wins",
  "first-wins",
  "unlimited",
]);

export type Concurrency = typeof concurrencySchema.Type;

/**
 * A start on a clock. `expression` is the phrase the editor builds and `cron`
 * the five-field form; either resolves to the same schedule.
 */
export const lifecycleScheduleSchema = Schema.Struct({
  expression: Schema.optional(Schema.String),
  cron: Schema.optional(Schema.String),
  timezone: Schema.optional(Schema.String),
});

export const lifecycleRulesSchema = Schema.Struct({
  /** Event names that start a run. */
  startEvents: Schema.Array(NonEmptyTrimmedString),
  /**
   * Event names that route in-flight runs to the Canceled outlet.
   *
   * The shape carries them and `checkLifecycleRules` refuses a non-empty list,
   * so the outlet arriving needs no change to what a saved graph holds.
   */
  cancelEvents: Schema.Array(NonEmptyTrimmedString),
  concurrency: concurrencySchema,

  /**
   * Start sources that are not Events.
   *
   * `allowManualStart` is what the Run button and the execute route are held to.
   * `schedule` is carried and refused: nothing in Rova ticks a clock yet, so the
   * shape is here for the panel to write into and the interim rule below turns
   * one away rather than accepting a workflow nothing can start.
   */
  schedule: Schema.optional(lifecycleScheduleSchema),
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
 * The rules a graph that declares none amounts to: nothing starts it.
 *
 * An entry node carrying no rules is every graph until the Lifecycle panel writes
 * them, and it is not the same thing as a graph that cannot run: an Event still
 * reaches the waits of runs parked inside it, which is what makes this an empty
 * declaration rather than a reason to skip the workflow.
 */
export const emptyLifecycleRules: LifecycleRules = {
  startEvents: [],
  cancelEvents: [],
  concurrency: "unlimited",
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

/**
 * Whether anything at all can start a run of this workflow.
 *
 * A schedule does not count: nothing in Rova ticks one yet, so a workflow whose
 * only start source is a schedule is a workflow nothing starts. The interim rule
 * below refuses one outright for the same reason.
 */
export function hasStartSource(rules: LifecycleRules): boolean {
  return rules.startEvents.length > 0 || rules.allowManualStart === true;
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
 * What a save is held to, as sentences a builder can be shown.
 *
 * The catalog is the vocabulary these rules are checked against, so a workflow
 * naming an Event the app no longer defines is refused where it is saved rather
 * than going quiet at delivery time.
 */
export function checkLifecycleRules(input: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
  /**
   * Event names the graph's Wait nodes park on. A wait matches by Entity Value
   * too, so it needs a Correlation Path for the same reason a cancel does.
   */
  waitEvents?: readonly string[];
}): LifecycleRulesCheck {
  const { rules, catalog } = input;
  const waitEvents = input.waitEvents ?? [];

  // ADR-0007 rejects one Event holding both roles rather than picking a winner,
  // which is what makes the one-role rule a set intersection.
  const bothRoles = rules.startEvents.filter((name) =>
    rules.cancelEvents.includes(name)
  );
  if (bothRoles.length > 0) {
    return refuse(
      `Event "${bothRoles[0]}" cannot both start and cancel runs of this workflow. Give it one role, or start on one Event and cancel on another.`
    );
  }

  for (const name of [...rules.startEvents, ...rules.cancelEvents]) {
    if (!findEvent(catalog, name)) {
      return refuse(
        `No Event named "${name}" is defined. Choose an Event this app declares, or ask whoever defines them to add it.`
      );
    }
  }

  // Every role that matches by Entity Value needs a path to read one at. A cancel
  // and a wait always do; a start does once Concurrency compares, and an
  // unlimited workflow may start on a correlation-free Event. A wait naming an
  // Event the catalog has never heard of is left out: the picker admits a free
  // name, and an Event nothing declares has no author to ask for a path.
  const matchByEntityValue = uniq([
    ...rules.cancelEvents,
    ...waitEvents.filter((name) => findEvent(catalog, name)),
    ...(rules.concurrency === "unlimited" ? [] : rules.startEvents),
  ]);

  for (const name of matchByEntityValue) {
    if (
      !resolveCorrelationPath({
        rules,
        eventName: name,
        declaredPath: findEvent(catalog, name)?.correlationPath,
      })
    ) {
      return refuse(missingCorrelationPathMessage(name));
    }
  }

  if (!hasStartSource(rules)) {
    return refuse(
      "Nothing can start this workflow. Add a Start Event, or allow manual starts."
    );
  }

  // Last, so a builder configuring cancellation is told about the missing path
  // or the unknown Event first: those are theirs to fix, and these are not.
  if (rules.cancelEvents.length > 0) {
    return refuse(
      "Cancel Events arrive with the Canceled outlet. Until then a workflow ends its own runs from the canvas."
    );
  }

  if (rules.schedule) {
    return refuse(
      "Schedules arrive with the Lifecycle panel. Until then a workflow starts from an Event or a manual run."
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
