import { isEmptyObject } from "es-toolkit/predicate";
import { useMemo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  carryCancelFilterToAddedEvents,
  pruneCancelFilters,
  setCancelFilterForAll,
  setCancelFilterForEvent,
} from "@wfgraph/shared/lifecycle/cancel-filters";
import {
  type Concurrency,
  inheritConnectionIds,
  initialLifecycleRules,
  type LifecycleRules,
  pruneConnectionIds,
  pruneCorrelationPaths,
  readLifecycleRules,
  setConnectionForIntegration,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import {
  carryStartFilterToAddedEvents,
  pruneStartFilters,
  setStartFilterForAll,
  setStartFilterForEvent,
} from "@wfgraph/shared/lifecycle/start-filters";
import { reconcileEntityBindings } from "./lifecycle-entity-eligibility-group";
import type { UpdateNodeConfig } from "./node-config-patch";

/** The Lifecycle Rules one node holds, and every write the Lifecycle editors make. */
export type LifecycleRulesEditor = {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
  setStartEvents: (eventNames: string[]) => void;
  setCancelEvents: (eventNames: string[]) => void;
  setConcurrency: (value: Concurrency) => void;
  setManualStart: (allowed: boolean) => void;
  setConnectionId: (integration: string, connectionId: string) => void;
  setStartFilter: (eventName: string, model: string | undefined) => void;
  setStartFilterForAll: (model: string | undefined) => void;
  setCancelFilter: (eventName: string, model: string | undefined) => void;
  setCancelFilterForAll: (model: string | undefined) => void;
  setCorrelationPath: (eventName: string, path: string) => void;
  /** Writes rules an editor built whole, such as the Entity group's. */
  setRules: (next: LifecycleRules) => void;
};

function prune(next: LifecycleRules, catalog: ExtensionCatalog) {
  return reconcileEntityBindings(
    pruneCancelFilters(
      pruneStartFilters(
        pruneConnectionIds(
          inheritConnectionIds(pruneCorrelationPaths(next), catalog)
        )
      )
    ),
    catalog
  );
}

/**
 * Reads a Lifecycle Node's rules from `config` and writes every change as the
 * complete Lifecycle Rules object through `onUpdateConfig`. A config with no
 * rules reads as the initial rules, and reading never persists them.
 */
export function useLifecycleRulesEditor(input: {
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
}): LifecycleRulesEditor {
  const { config, onUpdateConfig } = input;
  const catalog = useExtensionCatalog();
  // Decoded once per config, so `rules.startEvents` keeps its identity between
  // renders and the controls reading it can memoize the fields they derive.
  const rules = useMemo(
    () => readLifecycleRules(config) ?? initialLifecycleRules,
    [config]
  );

  const write = (next: LifecycleRules) => {
    onUpdateConfig({ lifecycleRules: next });
  };

  return {
    rules,
    catalog,
    // Adding an Event to a group that already shares one filter carries the
    // filter onto it. `prune` runs on every write, so it cannot tell an Event
    // that never had a filter from one the builder cleared on purpose.
    setStartEvents: (eventNames) =>
      write(
        carryStartFilterToAddedEvents({
          previous: rules,
          next: prune({ ...rules, startEvents: eventNames }, catalog),
          catalog,
        })
      ),
    setCancelEvents: (eventNames) =>
      write(
        carryCancelFilterToAddedEvents({
          previous: rules,
          next: prune({ ...rules, cancelEvents: eventNames }, catalog),
          catalog,
        })
      ),
    setConcurrency: (value) =>
      write(prune({ ...rules, concurrency: value }, catalog)),
    setManualStart: (allowed) => write({ ...rules, allowManualStart: allowed }),
    setConnectionId: (integration, connectionId) =>
      write(
        setConnectionForIntegration({
          rules,
          catalog,
          integration,
          connectionId,
        })
      ),
    setStartFilter: (eventName, model) =>
      write(setStartFilterForEvent({ rules, eventName, model })),
    setStartFilterForAll: (model) => write(setStartFilterForAll(rules, model)),
    setCancelFilter: (eventName, model) =>
      write(setCancelFilterForEvent({ rules, eventName, model })),
    setCancelFilterForAll: (model) =>
      write(setCancelFilterForAll(rules, model)),
    setCorrelationPath: (eventName, path) => {
      const trimmed = path.trim();
      const next = { ...rules.correlationPaths };
      if (trimmed) {
        next[eventName] = trimmed;
      } else {
        delete next[eventName];
      }
      write({
        ...rules,
        correlationPaths: isEmptyObject(next) ? undefined : next,
      });
    },
    // The Entity group's writes go through `prune` like every other write, so
    // selecting an Entity also clears the Correlation Paths tracking replaces.
    setRules: (next) => write(prune(next, catalog)),
  };
}
