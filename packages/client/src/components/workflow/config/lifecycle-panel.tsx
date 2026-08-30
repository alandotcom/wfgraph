import { useId, useState } from "react";
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
import { ConfigSection } from "./config-section";
import {
  IntegrationEventConnectionEditor,
  IntegrationEventConnectionSummary,
} from "./integration-event-connection";
import { LifecycleConcurrencyGroup } from "./lifecycle-concurrency-group";
import { LifecycleEventGroup } from "./lifecycle-event-group";
import type { UpdateNodeConfig } from "./node-config-patch";

export { CONCURRENCY_OPTIONS } from "./lifecycle-concurrency-group";

function prune(next: LifecycleRules, catalog: ExtensionCatalog) {
  return pruneConnectionIds(
    inheritConnectionIds(pruneCorrelationPaths(next), catalog)
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
  const rules = readLifecycleRules(config) ?? initialLifecycleRules;
  const [editing, setEditing] = useState(false);
  const check = checkLifecycleRules({ rules, catalog });

  const write = (next: LifecycleRules) => {
    onUpdateConfig({ lifecycleRules: next });
  };

  const setStartEvents = (eventNames: string[]) => {
    write(prune({ ...rules, startEvents: eventNames }, catalog));
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
      correlationPaths: Object.keys(next).length > 0 ? next : undefined,
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
  };

  return (
    <div className="space-y-4">
      <ConfigSection
        editable={!disabled}
        editing={editing}
        help={LIFECYCLE_RULES_HELP.map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
        label="Lifecycle Rules"
        onEditingChange={setEditing}
        stickyHeader
        view={
          <LifecycleGroups
            editing={false}
            onConnectionChange={setConnectionId}
            {...groupProps}
          />
        }
      >
        <LifecycleGroups
          editing
          onConnectionChange={setConnectionId}
          {...groupProps}
        />
      </ConfigSection>

      {check.valid ? null : (
        <WarningCallout title="This will not save">
          {check.error}
        </WarningCallout>
      )}
    </div>
  );
}

function LifecycleGroups({
  editing,
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
  onConnectionChange,
}: {
  editing: boolean;
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
  onConnectionChange: (integration: string, connectionId: string) => void;
}) {
  return (
    <div className="divide-y">
      <LifecycleEventGroup
        catalog={catalog}
        disabled={disabled}
        editing={editing}
        inputId={startEventId}
        onCorrelationPathChange={onCorrelationPathChange}
        onEventNamesChange={onStartEventsChange}
        role="start"
        rules={rules}
      />
      <LifecycleConcurrencyGroup
        disabled={disabled}
        editing={editing}
        manualStartId={manualStartId}
        onConcurrencyChange={onConcurrencyChange}
        onManualStartChange={onManualStartChange}
        rules={rules}
      />
      <LifecycleEventGroup
        catalog={catalog}
        disabled={disabled}
        editing={editing}
        inputId={cancelEventsId}
        onCorrelationPathChange={onCorrelationPathChange}
        onEventNamesChange={onCancelEventsChange}
        role="cancel"
        rules={rules}
      />
      {uniqueIntegrationsOfEvents(catalog, [
        ...rules.startEvents,
        ...rules.cancelEvents,
      ]).map((integration) =>
        editing ? (
          <IntegrationEventConnectionEditor
            catalog={catalog}
            connectionId={connectionIdForIntegration(
              rules,
              catalog,
              integration
            )}
            disabled={disabled}
            integrationType={integration}
            key={integration}
            onChange={(connectionId) =>
              onConnectionChange(integration, connectionId)
            }
          />
        ) : (
          <IntegrationEventConnectionSummary
            catalog={catalog}
            connectionId={connectionIdForIntegration(
              rules,
              catalog,
              integration
            )}
            integrationType={integration}
            key={integration}
          />
        )
      )}
    </div>
  );
}

const LIFECYCLE_RULES_HELP = [
  "What starts a run of this workflow.",
  "What happens to runs in progress when another start arrives.",
];
