import { useId, useMemo } from "react";
import { isEmptyObject } from "es-toolkit/predicate";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { WarningCallout } from "#src/components/ui/callout";
import {
  type ExtensionCatalog,
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
  carryStartFilterToAddedEvents,
  pruneStartFilters,
  setStartFilterForAll,
  setStartFilterForEvent,
} from "@wfgraph/shared/lifecycle/start-filters";
import { IntegrationEventConnectionEditor } from "./integration-event-connection";
import { LifecycleConcurrencyGroup } from "./lifecycle-concurrency-group";
import { LifecycleEventGroup } from "./lifecycle-event-group";
import type { UpdateNodeConfig } from "./node-config-patch";

export { CONCURRENCY_OPTIONS } from "./lifecycle-concurrency-group";

function prune(next: LifecycleRules, catalog: ExtensionCatalog) {
  return pruneStartFilters(
    pruneConnectionIds(
      inheritConnectionIds(pruneCorrelationPaths(next), catalog)
    )
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
    write(prune({ ...rules, cancelEvents: eventNames }, catalog));
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
  };

  return (
    <div className="space-y-4">
      <LifecycleGroups onConnectionChange={setConnectionId} {...groupProps} />

      {check.valid ? null : (
        <WarningCallout title="This will not save">
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
  onConnectionChange,
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
  onConnectionChange: (integration: string, connectionId: string) => void;
}) {
  return (
    <div className="divide-y">
      <LifecycleEventGroup
        catalog={catalog}
        disabled={disabled}
        inputId={startEventId}
        onCorrelationPathChange={onCorrelationPathChange}
        onEventNamesChange={onStartEventsChange}
        onStartFilterChange={onStartFilterChange}
        onStartFilterChangeForAll={onStartFilterChangeForAll}
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
        role="cancel"
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
