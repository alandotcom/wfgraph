/**
 * The words the Lifecycle editors use to describe a node's Lifecycle Rules:
 * each rule's name, the overlapping-run choices, Event and Entity labels, and
 * which runs count as related. A name the catalog no longer declares reads as
 * the stored name.
 */

import {
  type ExtensionCatalog,
  findEntity,
  findEvent,
} from "@wfgraph/shared/extensions/catalog";
import type {
  Concurrency,
  LifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";

/**
 * The one name each start rule goes by, in the words of what it does: its
 * "Add a rule" item (with an ellipsis) and its label in the Start's form. The
 * form names the eligibility rule for the tracked Entity, such as "Only while
 * the patient matches". CONTEXT.md keeps the domain nouns: Start Event, Start
 * Filter, Concurrency, Schedule, Cancel Event, tracked Entity, Entity
 * Eligibility.
 */
export const START_RULE_NAMES = {
  starts: "Starts when",
  startFilter: "Only start when",
  overlapping: "If a run is already in progress",
  schedule: "On a schedule",
  stop: "Stop a run when",
  entity: "One run per",
  eligibility: "Only while the record matches",
} as const;

export const CONCURRENCY_OPTIONS: ReadonlyArray<{
  value: Concurrency;
  label: string;
  description: string;
}> = [
  {
    value: "unlimited",
    label: "Start every run",
    description: "Each arrival starts a separate run.",
  },
  {
    value: "newest-wins",
    label: "Start the newest run",
    description: "End related active runs, then start the new run.",
  },
  {
    value: "first-wins",
    label: "Keep the active run",
    description: "Keep related active runs and do not start the new run.",
  },
];

export function eventLabel(catalog: ExtensionCatalog, eventName: string) {
  return findEvent(catalog, eventName)?.label ?? eventName;
}

/** The tracked Entity's label, or null when the rules track none. */
export function trackedEntityLabel(
  rules: LifecycleRules,
  catalog: ExtensionCatalog
): string | null {
  const tracked = rules.trackedEntity;
  return tracked
    ? (findEntity(catalog, tracked.type)?.label ?? tracked.type)
    : null;
}

/** How this policy decides which runs overlap or match a Cancel Event. */
export function describeRelatedRuns(
  rules: LifecycleRules,
  catalog: ExtensionCatalog
): string {
  const entityLabel = trackedEntityLabel(rules, catalog);
  if (entityLabel) {
    return `Each run tracks a ${entityLabel} ID. Runs with the same ID are related.`;
  }

  const hasLifecycleEvents =
    rules.startEvents.length > 0 || rules.cancelEvents.length > 0;
  if (!hasLifecycleEvents) {
    return rules.concurrency === "unlimited"
      ? "Every manual start creates a separate run."
      : "With no start or Cancel Events, the overlapping-run rule treats all manual runs as related.";
  }

  if (rules.concurrency !== "unlimited" || rules.cancelEvents.length > 0) {
    return "Start and Cancel Events use their Correlation Path values to identify related runs.";
  }

  return "Runs are not matched while every arrival starts a separate run and no Cancel Event is configured.";
}
