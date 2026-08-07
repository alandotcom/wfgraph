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
 * WfGraph's own rather than Inngest's: newest-wins has to end the displaced run
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
   * The Events that start a run, empty when no Event does.
   *
   * Several of them is how one workflow answers an appointment being booked and
   * being moved: both runs walk the same graph, and newest-wins Concurrency ends
   * the one already going. What a node behind Started may address is then what
   * those Events agree on, and an Event Split is what tells them apart.
   */
  startEvents: Schema.Array(NonEmptyTrimmedString),
  /** Event names that route in-flight runs to the Canceled outlet. */
  cancelEvents: Schema.Array(NonEmptyTrimmedString),
  concurrency: concurrencySchema,

  /**
   * The start source that is not an Event: the Run button and the execute route.
   *
   * A clock is the other one the design names, and it is absent rather than
   * carried-and-refused, because nothing in WfGraph can write one. It arrives with
   * whatever ticks it, and the panel says so where a builder looks for it.
   */
  allowManualStart: Schema.optional(Schema.Boolean),

  /**
   * The Correlation Path this workflow reads an Event at, keyed by Event name.
   *
   * It outranks the Event's own declaration, so one Event can identify an
   * appointment in one workflow and the patient it belongs to in the next.
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
  startEvents: [],
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

/** Whether this Lifecycle Node config lists at least one Cancel Event. */
export function configDeclaresCancelEvent(
  config: Record<string, unknown> | undefined
): boolean {
  return (readLifecycleRules(config)?.cancelEvents.length ?? 0) > 0;
}

/**
 * Where an Event's Entity Value sits for this workflow: the builder's path, or
 * the Event Author's declaration where the builder wrote none.
 *
 * The declaration is a default rather than a verdict. An Event names the entity
 * its own author had in mind, and the workflow reading it may be about a
 * different one, so the per-workflow value wins.
 */
export function resolveCorrelationPath(input: {
  rules: LifecycleRules;
  eventName: string;
  declaredPath?: string;
}): string | undefined {
  return input.rules.correlationPaths?.[input.eventName] ?? input.declaredPath;
}

/** Whether anything at all can start a run of this workflow. */
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
  /** The Event Author's declaration, which stands until the builder overrides it. */
  declaredPath?: string;
  /** The builder's own path for this workflow, absent while the declaration stands. */
  suppliedPath?: string;
};

/**
 * Whether a Start Event's Entity Value is compared against anything.
 *
 * Concurrency compares it directly. A Cancel Event compares it too, at one remove:
 * the value a start reads lands on the execution row, and that row is what a
 * cancel's own Entity Value is matched against. So a workflow with a Cancel Event
 * needs its Start Events' paths exactly as much as one with Concurrency set,
 * whatever Concurrency itself says.
 */
function startMatchesByEntityValue(rules: LifecycleRules): boolean {
  return rules.concurrency !== "unlimited" || rules.cancelEvents.length > 0;
}

/**
 * One Event's Correlation Path request for this workflow, or undefined for a
 * Start Event that currently matches nothing (`startMatchesByEntityValue`).
 *
 * A Cancel Event always matches by entity, so a `role: "cancel"` request is never
 * undefined -- overloaded on that literal so a caller asking for a cancel role
 * does not carry optionality the value never has.
 */
export function correlationPathRequestFor(input: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
  eventName: string;
  role: "cancel";
}): CorrelationPathRequest;
export function correlationPathRequestFor(input: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
  eventName: string;
  role: CorrelationPathRole;
}): CorrelationPathRequest | undefined;
export function correlationPathRequestFor(input: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
  eventName: string;
  role: CorrelationPathRole;
}): CorrelationPathRequest | undefined {
  const { rules, catalog, eventName, role } = input;

  if (role === "start" && !startMatchesByEntityValue(rules)) {
    return undefined;
  }

  return {
    eventName,
    role,
    declaredPath: findEvent(catalog, eventName)?.correlationPath,
    suppliedPath: rules.correlationPaths?.[eventName],
  };
}

/**
 * The Events this workflow matches by Entity Value, each with both paths, so the
 * panel can render one control showing the default and the override together.
 *
 * A wait is not here: a Wait Subscription carries its own match expression, so
 * what an arriving payload is compared against is stated on the Wait node itself.
 *
 * An Event whose author declared a path is a member like any other, because the
 * builder may need a different field of the same payload. What the save refuses on
 * is a member with neither path, which `checkLifecycleRules` narrows to.
 */
export function eventsNeedingCorrelationPath(input: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
}): CorrelationPathRequest[] {
  const { rules, catalog } = input;

  const starts = rules.startEvents.map((eventName) =>
    correlationPathRequestFor({ rules, catalog, eventName, role: "start" })
  );

  const cancels = rules.cancelEvents.map((eventName) =>
    correlationPathRequestFor({ rules, catalog, eventName, role: "cancel" })
  );

  return compact([...starts, ...cancels]);
}

/**
 * `rules.correlationPaths`, holding only the Events `eventsNeedingCorrelationPath`
 * currently lists.
 *
 * The panel calls this from every setter that can change which Events hold a
 * role or whether a Start Event matches by entity -- `setStartEvent`,
 * `setCancelEvents`, and the Concurrency radio -- so an override for an Event
 * that just lost its role does not keep governing runs once its own control has
 * left the screen. A stale start override is the sharper case: a Start Event
 * keeps its role across a Concurrency change, so only pruning by current need
 * (not by role alone) drops it when Concurrency stops comparing and no Cancel
 * Event takes over the reason.
 */
export function pruneCorrelationPaths(rules: LifecycleRules): LifecycleRules {
  if (!rules.correlationPaths) {
    return rules;
  }

  const needed = new Set(rules.cancelEvents);
  if (startMatchesByEntityValue(rules)) {
    for (const eventName of rules.startEvents) {
      needed.add(eventName);
    }
  }

  const next = Object.fromEntries(
    Object.entries(rules.correlationPaths).filter(([eventName]) =>
      needed.has(eventName)
    )
  );

  return {
    ...rules,
    correlationPaths: Object.keys(next).length > 0 ? next : undefined,
  };
}

/**
 * What a save is held to, as sentences a builder can be shown.
 *
 * The catalog is the vocabulary these rules are checked against, so a workflow
 * naming an Event the app does not define is refused where it is saved rather
 * than going quiet at delivery time.
 */
export function checkLifecycleRules(input: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
}): LifecycleRulesCheck {
  const { rules, catalog } = input;

  // ADR-0007 rejects one Event holding both roles rather than picking a winner,
  // which with two lists is where they intersect.
  const bothRoles = rules.startEvents.find((eventName) =>
    rules.cancelEvents.includes(eventName)
  );
  if (bothRoles) {
    return refuse(
      `Event "${bothRoles}" cannot both start and cancel runs of this workflow. Give it one role, or start on one Event and cancel on another.`
    );
  }

  const named = [...rules.startEvents, ...rules.cancelEvents];
  for (const name of named) {
    if (!findEvent(catalog, name)) {
      return refuse(unknownEventMessage(name));
    }
  }

  // Same rule as `resolveCorrelationPath`: the builder's path outranks the
  // declaration. Called rather than re-inlined, so a change to precedence
  // cannot update one copy and miss the other.
  const owed = eventsNeedingCorrelationPath({ rules, catalog }).find(
    (request) =>
      !resolveCorrelationPath({
        rules,
        eventName: request.eventName,
        declaredPath: request.declaredPath,
      })
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
