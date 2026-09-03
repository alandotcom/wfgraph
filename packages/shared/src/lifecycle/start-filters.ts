/**
 * The Start Filter: the condition an arrival must satisfy before a run opens.
 * It is stored per Start Event on the Lifecycle Rules (ADR-0016).
 *
 * The condition implementation is shared with Cancel Filters. This module keeps
 * the start-specific public names used by the editor and delivery code.
 */

import type { ExtensionCatalog } from "#src/extensions/catalog";
import {
  carryFilterToAddedEvents,
  checkFilterModels,
  checkFilters,
  pruneFilters,
  readFilter,
  readFilterLayout,
  setFilterForAll,
  setFilterForEvent,
  type FilterLayout,
} from "#src/lifecycle/filter-helpers";
import type {
  LifecycleRules,
  LifecycleRulesCheck,
} from "#src/lifecycle/lifecycle-rules";

/** Whether one control can stand for every Start Event's filter. */
export type StartFilterLayout = FilterLayout;

/** Checks that every stored Start Filter can be parsed and compiled. */
export function checkStartFilterModels(
  rules: LifecycleRules
): LifecycleRulesCheck {
  return checkFilterModels(rules, "start");
}

/** Checks that every Start Filter is complete and readable by its Event. */
export function checkStartFilters(input: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
}): LifecycleRulesCheck {
  return checkFilters({ ...input, role: "start" });
}

/** The stored Start Filter for one Event, absent when it has none. */
export function readStartFilter(
  rules: LifecycleRules,
  eventName: string
): string | undefined {
  return readFilter(rules, "start", eventName);
}

/** Reads whether all Start Events share one filter model. */
export function readStartFilterLayout(
  rules: LifecycleRules
): StartFilterLayout {
  return readFilterLayout(rules, "start");
}

/** Writes or clears one Event's Start Filter. */
export function setStartFilterForEvent(input: {
  rules: LifecycleRules;
  eventName: string;
  model: string | undefined;
}): LifecycleRules {
  return setFilterForEvent({ ...input, role: "start" });
}

/** Writes one Start Filter to every Start Event, or clears the group. */
export function setStartFilterForAll(
  rules: LifecycleRules,
  model: string | undefined
): LifecycleRules {
  return setFilterForAll(rules, "start", model);
}

/** Carries a shared Start Filter onto newly added Events that can read it. */
export function carryStartFilterToAddedEvents(input: {
  previous: LifecycleRules;
  next: LifecycleRules;
  catalog: ExtensionCatalog;
}): LifecycleRules {
  return carryFilterToAddedEvents({ ...input, role: "start" });
}

/** Drops filters for Events that no longer hold the start role. */
export function pruneStartFilters(rules: LifecycleRules): LifecycleRules {
  return pruneFilters(rules, "start");
}
