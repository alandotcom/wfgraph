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
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { CONCURRENCY_OPTIONS } from "./lifecycle-concurrency-group";

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
