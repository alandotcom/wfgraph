/**
 * The Cancel Filter: the condition an arriving Cancel Event must satisfy before
 * it cancels a run. It is stored per Cancel Event on the Lifecycle Rules.
 *
 * A Cancel Filter is read before cancellation, so its operands describe the
 * arriving payload and cannot refer to values produced by the run being ended.
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

/** Whether one control can stand for every Cancel Event's filter. */
export type CancelFilterLayout = FilterLayout;

/** Checks that every stored Cancel Filter can be parsed and compiled. */
export function checkCancelFilterModels(
  rules: LifecycleRules
): LifecycleRulesCheck {
  return checkFilterModels(rules, "cancel");
}

/** Checks that every Cancel Filter is complete and readable by its Event. */
export function checkCancelFilters(input: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
}): LifecycleRulesCheck {
  return checkFilters({ ...input, role: "cancel" });
}

/** The stored Cancel Filter for one Event, absent when it has none. */
export function readCancelFilter(
  rules: LifecycleRules,
  eventName: string
): string | undefined {
  return readFilter(rules, "cancel", eventName);
}

/** Reads whether all Cancel Events share one filter model. */
export function readCancelFilterLayout(
  rules: LifecycleRules
): CancelFilterLayout {
  return readFilterLayout(rules, "cancel");
}

/** Writes or clears one Event's Cancel Filter. */
export function setCancelFilterForEvent(input: {
  rules: LifecycleRules;
  eventName: string;
  model: string | undefined;
}): LifecycleRules {
  return setFilterForEvent({ ...input, role: "cancel" });
}

/** Writes one Cancel Filter to every Cancel Event, or clears the group. */
export function setCancelFilterForAll(
  rules: LifecycleRules,
  model: string | undefined
): LifecycleRules {
  return setFilterForAll(rules, "cancel", model);
}

/** Carries a shared Cancel Filter onto newly added Events that can read it. */
export function carryCancelFilterToAddedEvents(input: {
  previous: LifecycleRules;
  next: LifecycleRules;
  catalog: ExtensionCatalog;
}): LifecycleRules {
  return carryFilterToAddedEvents({ ...input, role: "cancel" });
}

/** Drops filters for Events that no longer hold the cancel role. */
export function pruneCancelFilters(rules: LifecycleRules): LifecycleRules {
  return pruneFilters(rules, "cancel");
}
