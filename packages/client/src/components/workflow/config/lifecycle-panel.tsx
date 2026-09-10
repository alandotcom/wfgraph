import { useId, useMemo } from "react";
import { isEmptyObject } from "es-toolkit/predicate";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { WarningCallout } from "#src/components/ui/callout";
import {
  type ExtensionCatalog,
  findEntity,
  findEvent,
  uniqueIntegrationsOfEvents,
} from "@wfgraph/shared/extensions/catalog";
import {
  checkLifecycleRules,
  connectionIdForIntegration,
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
  carryCancelFilterToAddedEvents,
  pruneCancelFilters,
  setCancelFilterForAll,
  setCancelFilterForEvent,
} from "@wfgraph/shared/lifecycle/cancel-filters";
import {
  carryStartFilterToAddedEvents,
  pruneStartFilters,
  setStartFilterForAll,
  setStartFilterForEvent,
} from "@wfgraph/shared/lifecycle/start-filters";
import { IntegrationEventConnectionEditor } from "./integration-event-connection";
import {
  CONCURRENCY_OPTIONS,
  LifecycleConcurrencyGroup,
} from "./lifecycle-concurrency-group";
import {
  LifecycleEntityEligibilityGroup,
  reconcileEntityBindings,
} from "./lifecycle-entity-eligibility-group";
import { LifecycleEventGroup } from "./lifecycle-event-group";
import type { UpdateNodeConfig } from "./node-config-patch";

export { CONCURRENCY_OPTIONS } from "./lifecycle-concurrency-group";

function eventLabels(
  eventNames: readonly string[],
  catalog: ExtensionCatalog
): string {
  return eventNames
    .map((eventName) => findEvent(catalog, eventName)?.label ?? eventName)
    .join(", ");
}

function eligibilityTiming(rules: LifecycleRules): string {
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

function LifecycleSummary({
  rules,
  catalog,
}: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
}) {
  const startSources = [
    ...rules.startEvents.map(
      (eventName) => findEvent(catalog, eventName)?.label ?? eventName
    ),
    ...(rules.allowManualStart ? ["Manual runs"] : []),
  ];
  const concurrency = CONCURRENCY_OPTIONS.find(
    (option) => option.value === rules.concurrency
  )?.label;
  const tracked = rules.trackedEntity
    ? (findEntity(catalog, rules.trackedEntity.type)?.label ??
      rules.trackedEntity.type)
    : "Not tracked";
  const rows = [
    { label: "Starts", value: startSources.join(", ") || "Not configured" },
    { label: "Overlapping runs", value: concurrency ?? rules.concurrency },
    {
      label: "Stops",
      value: eventLabels(rules.cancelEvents, catalog) || "No cancel events",
    },
    { label: "Tracks", value: tracked },
    { label: "Eligibility", value: eligibilityTiming(rules) },
  ];

  return (
    <section
      aria-label="Lifecycle summary"
      className="rounded-md border bg-muted/30 px-3 py-2"
    >
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {rows.map((row) => (
          <div className="contents" key={row.label}>
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 text-right text-foreground">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
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
 * The Lifecycle Node's panel: what starts a run and what happens to runs already
 * in progress. Every control writes the complete Lifecycle Rules object. Reads
 * use the initial rules as a fallback; opening the panel never persists them.
 */
export function LifecyclePanel({
  config,
  onUpdateConfig,
  disabled,
}: {
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled: boolean;
}) {
  const startEventId = useId();
  const cancelEventsId = useId();
  const manualStartId = useId();
  const catalog = useExtensionCatalog();
  // Decoded once per config rather than once per render, so `rules.startEvents`
  // keeps its identity between renders and the controls below can memoize the
  // field derivations they hang off it.
  const rules = useMemo(
    () => readLifecycleRules(config) ?? initialLifecycleRules,
    [config]
  );
  const check = checkLifecycleRules({ rules, catalog });

  const write = (next: LifecycleRules) => {
    onUpdateConfig({ lifecycleRules: next });
  };

  const setStartEvents = (eventNames: string[]) => {
    // Adding a Start Event to a group that already shares one filter carries the
    // filter onto it. Done here rather than inside `prune`, which runs on every
    // write and so could not tell an Event that never had a filter from one the
    // builder cleared on purpose.
    write(
      carryStartFilterToAddedEvents({
        previous: rules,
        next: prune({ ...rules, startEvents: eventNames }, catalog),
        catalog,
      })
    );
  };

  const setCancelEvents = (eventNames: string[]) => {
    write(
      carryCancelFilterToAddedEvents({
        previous: rules,
        next: prune({ ...rules, cancelEvents: eventNames }, catalog),
        catalog,
      })
    );
  };

  const setConcurrency = (value: Concurrency) => {
    write(prune({ ...rules, concurrency: value }, catalog));
  };

  const setConnectionId = (integration: string, connectionId: string) => {
    write(
      setConnectionForIntegration({
        rules,
        catalog,
        integration,
        connectionId,
      })
    );
  };

  const setStartFilter = (eventName: string, model: string | undefined) => {
    write(setStartFilterForEvent({ rules, eventName, model }));
  };

  const setStartFilterForEveryEvent = (model: string | undefined) => {
    write(setStartFilterForAll(rules, model));
  };

  const setCancelFilter = (eventName: string, model: string | undefined) => {
    write(setCancelFilterForEvent({ rules, eventName, model }));
  };

  const setCancelFilterForEveryEvent = (model: string | undefined) => {
    write(setCancelFilterForAll(rules, model));
  };

  const setCorrelationPath = (eventName: string, path: string) => {
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
  };

  const groupProps = {
    rules,
    catalog,
    disabled,
    startEventId,
    cancelEventsId,
    manualStartId,
    onStartEventsChange: setStartEvents,
    onCancelEventsChange: setCancelEvents,
    onConcurrencyChange: setConcurrency,
    onManualStartChange: (allowed: boolean) =>
      write({ ...rules, allowManualStart: allowed }),
    onCorrelationPathChange: setCorrelationPath,
    onStartFilterChange: setStartFilter,
    onStartFilterChangeForAll: setStartFilterForEveryEvent,
    onCancelFilterChange: setCancelFilter,
    onCancelFilterChangeForAll: setCancelFilterForEveryEvent,
    // The Entity group's writes go through prune like every other write in
    // this panel, so selecting an Entity also clears the Correlation Paths
    // that tracking an Entity makes invalid.
    onRulesChange: (next: LifecycleRules) => write(prune(next, catalog)),
  };

  return (
    <div className="space-y-4">
      <LifecycleSummary catalog={catalog} rules={rules} />
      <LifecycleGroups onConnectionChange={setConnectionId} {...groupProps} />

      {check.valid ? null : (
        <WarningCallout title="Lifecycle settings need attention">
          {check.error}
        </WarningCallout>
      )}
    </div>
  );
}

function LifecycleGroups({
  rules,
  catalog,
  disabled,
  startEventId,
  cancelEventsId,
  manualStartId,
  onStartEventsChange,
  onCancelEventsChange,
  onConcurrencyChange,
  onManualStartChange,
  onCorrelationPathChange,
  onStartFilterChange,
  onStartFilterChangeForAll,
  onCancelFilterChange,
  onCancelFilterChangeForAll,
  onConnectionChange,
  onRulesChange,
}: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
  disabled: boolean;
  startEventId: string;
  cancelEventsId: string;
  manualStartId: string;
  onStartEventsChange: (eventNames: string[]) => void;
  onCancelEventsChange: (eventNames: string[]) => void;
  onConcurrencyChange: (value: Concurrency) => void;
  onManualStartChange: (allowed: boolean) => void;
  onCorrelationPathChange: (eventName: string, path: string) => void;
  onStartFilterChange: (eventName: string, model: string | undefined) => void;
  onStartFilterChangeForAll: (model: string | undefined) => void;
  onCancelFilterChange: (eventName: string, model: string | undefined) => void;
  onCancelFilterChangeForAll: (model: string | undefined) => void;
  onConnectionChange: (integration: string, connectionId: string) => void;
  onRulesChange: (rules: LifecycleRules) => void;
}) {
  return (
    <div className="divide-y">
      <LifecycleEventGroup
        catalog={catalog}
        disabled={disabled}
        inputId={startEventId}
        onCorrelationPathChange={onCorrelationPathChange}
        onEventNamesChange={onStartEventsChange}
        onFilterChange={onStartFilterChange}
        onFilterChangeForAll={onStartFilterChangeForAll}
        role="start"
        rules={rules}
      />
      <LifecycleConcurrencyGroup
        disabled={disabled}
        manualStartId={manualStartId}
        onConcurrencyChange={onConcurrencyChange}
        onManualStartChange={onManualStartChange}
        rules={rules}
      />
      <LifecycleEventGroup
        catalog={catalog}
        disabled={disabled}
        inputId={cancelEventsId}
        onCorrelationPathChange={onCorrelationPathChange}
        onEventNamesChange={onCancelEventsChange}
        onFilterChange={onCancelFilterChange}
        onFilterChangeForAll={onCancelFilterChangeForAll}
        role="cancel"
        rules={rules}
      />
      <LifecycleEntityEligibilityGroup
        catalog={catalog}
        disabled={disabled}
        onChange={onRulesChange}
        rules={rules}
      />
      {uniqueIntegrationsOfEvents(catalog, [
        ...rules.startEvents,
        ...rules.cancelEvents,
      ]).map((integration) => (
        <IntegrationEventConnectionEditor
          catalog={catalog}
          connectionId={connectionIdForIntegration(rules, catalog, integration)}
          disabled={disabled}
          integrationType={integration}
          key={integration}
          onChange={(connectionId) =>
            onConnectionChange(integration, connectionId)
          }
        />
      ))}
    </div>
  );
}
