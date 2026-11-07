import { isEmptyObject, isEqual } from "es-toolkit/predicate";
import { useMemo, useState } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { CronSchedule } from "@wfgraph/shared/lifecycle/cron-schedule";
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
import {
  rowOfSchedule,
  type ScheduleRefusal,
  type ScheduleRow,
  scheduleRefusalOf,
  schedulesOfRows,
} from "./lifecycle-schedule";
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
  schedules: ScheduleEditor;
};

/**
 * The Schedule group's rows and the refusal they earn. `setRows` writes the
 * rows to the stored rules when a save would accept them, and otherwise keeps
 * them here, unsaved, beside the refusal that explains why.
 */
export type ScheduleEditor = {
  /** The schedules the stored rules hold, which Undo restores. */
  stored: readonly CronSchedule[];
  rows: ScheduleRow[];
  refusal: ScheduleRefusal | undefined;
  setRows: (rows: ScheduleRow[]) => void;
};

const NO_SCHEDULES: readonly CronSchedule[] = [];

/**
 * The rows the builder is editing, and the stored schedules they were edited
 * from. The rows stand while the stored schedules still match; an edit from
 * elsewhere, such as Undo or the build agent, replaces them with rows read from
 * the new schedules.
 */
type ScheduleDraft = {
  rows: ScheduleRow[];
  stored: readonly CronSchedule[];
};

function useScheduleEditor(input: {
  rules: LifecycleRules;
  write: (next: LifecycleRules) => void;
}): ScheduleEditor {
  const { rules, write } = input;
  const stored = rules.schedules ?? NO_SCHEDULES;
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const editing = draft !== null && isEqual(draft.stored, stored);

  return {
    stored,
    rows: editing ? draft.rows : stored.map(rowOfSchedule),
    // Rows read from the stored rules decoded already, so only an edit can be
    // refused.
    refusal: editing ? scheduleRefusalOf(draft.rows) : undefined,
    setRows: (rows) => {
      if (scheduleRefusalOf(rows)) {
        setDraft({ rows, stored });
        return;
      }
      const schedules = schedulesOfRows(rows);
      setDraft({ rows, stored: schedules });
      if (!isEqual(schedules, stored)) {
        write({
          ...rules,
          schedules: schedules.length > 0 ? schedules : undefined,
        });
      }
    },
  };
}

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
  const schedules = useScheduleEditor({ rules, write });

  return {
    rules,
    catalog,
    schedules,
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
