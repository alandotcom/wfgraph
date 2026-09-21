/**
 * The words the Lifecycle editors use to describe a node's Lifecycle Rules:
 * Event and Entity labels, overlapping-run behavior, eligibility timing, and
 * the tracked Entity's binding in each Event. A name the catalog no longer
 * declares reads as the stored name.
 */

import { uniq } from "es-toolkit/array";
import {
  type ExtensionCatalog,
  findEntity,
  findEvent,
} from "@wfgraph/shared/extensions/catalog";
import type {
  Concurrency,
  LifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";

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

/** The label and description of the rules' overlapping-run behavior. */
export function concurrencySummary(rules: LifecycleRules): {
  label: string;
  description: string | undefined;
} {
  const option = CONCURRENCY_OPTIONS.find(
    (entry) => entry.value === rules.concurrency
  );
  return {
    label: option?.label ?? rules.concurrency,
    description: option?.description,
  };
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
      : "With no Lifecycle Events, the overlapping-run rule treats all manual runs as related.";
  }

  if (rules.concurrency !== "unlimited" || rules.cancelEvents.length > 0) {
    return "Lifecycle Events use their Correlation Path values to identify related runs.";
  }

  return "Runs are not matched while every arrival starts a separate run and no Cancel Event is configured.";
}

/** When Entity Eligibility is checked, or what it still needs before it can be. */
export function eligibilityTiming(rules: LifecycleRules): string {
  const eligibility = rules.entityEligibility;
  if (!eligibility) {
    return "None (optional)";
  }
  if (!eligibility.condition) {
    return "Rule required";
  }

  const beforeStart = eligibility.checkpoints.includes("before-execution");
  const beforeStep = eligibility.checkpoints.includes("before-node");
  if (beforeStart && beforeStep) {
    return "Before starting and each step";
  }
  if (beforeStart) {
    return "Before starting";
  }
  if (beforeStep) {
    return "Before each step";
  }
  return "Timing required";
}

/**
 * One row per Start and Cancel Event naming the tracked Entity's binding in
 * that Event, or a null binding where none is chosen. Empty when the rules
 * track no Entity.
 */
export function entityBindingRows(
  rules: LifecycleRules,
  catalog: ExtensionCatalog
): { eventName: string; eventLabel: string; binding: string | null }[] {
  const tracked = rules.trackedEntity;
  if (!tracked) {
    return [];
  }
  return uniq([...rules.startEvents, ...rules.cancelEvents]).map(
    (eventName) => ({
      eventName,
      eventLabel: eventLabel(catalog, eventName),
      binding: tracked.bindings[eventName] ?? null,
    })
  );
}
