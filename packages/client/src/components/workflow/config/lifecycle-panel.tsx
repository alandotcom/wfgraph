import { useId } from "react";
import { WarningCallout } from "#src/components/ui/callout";
import { LifecyclePolicySections } from "#src/components/workflow/canvas-reveal/lifecycle-browse";
import { uniqueIntegrationsOfEvents } from "@wfgraph/shared/extensions/catalog";
import {
  checkLifecycleRules,
  connectionIdForIntegration,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { IntegrationEventConnectionEditor } from "./integration-event-connection";
import { LifecycleConcurrencyGroup } from "./lifecycle-concurrency-group";
import { LifecycleEntityEligibilityGroup } from "./lifecycle-entity-eligibility-group";
import { LifecycleEventGroup } from "./lifecycle-event-group";
import type { UpdateNodeConfig } from "./node-config-patch";
import {
  type LifecycleRulesEditor,
  useLifecycleRulesEditor,
} from "./use-lifecycle-rules-editor";

export { CONCURRENCY_OPTIONS } from "./lifecycle-policy-summary";

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
  const editor = useLifecycleRulesEditor({ config, onUpdateConfig });
  const check = checkLifecycleRules({
    rules: editor.rules,
    catalog: editor.catalog,
  });

  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-muted/30">
        <LifecyclePolicySections rules={editor.rules} />
      </div>
      <LifecycleGroups disabled={disabled} editor={editor} />

      {check.valid ? null : (
        <WarningCallout title="Lifecycle settings need attention">
          {check.error}
        </WarningCallout>
      )}
    </div>
  );
}

function LifecycleGroups({
  editor,
  disabled,
}: {
  editor: LifecycleRulesEditor;
  disabled: boolean;
}) {
  const manualStartId = useId();
  return (
    <div className="divide-y">
      <LifecycleRoleEventGroup
        disabled={disabled}
        editor={editor}
        role="start"
      />
      <LifecycleConcurrencyGroup
        disabled={disabled}
        manualStartId={manualStartId}
        onConcurrencyChange={editor.setConcurrency}
        onManualStartChange={editor.setManualStart}
        rules={editor.rules}
      />
      <LifecycleRoleEventGroup
        disabled={disabled}
        editor={editor}
        role="cancel"
      />
      <LifecycleEntityEligibilityGroup
        catalog={editor.catalog}
        disabled={disabled}
        onChange={editor.setRules}
        rules={editor.rules}
      />
      <LifecycleEventConnections disabled={disabled} editor={editor} />
    </div>
  );
}

/** The Start or Cancel Events group, writing through one Lifecycle Rules editor. */
export function LifecycleRoleEventGroup({
  role,
  editor,
  disabled,
}: {
  role: "start" | "cancel";
  editor: LifecycleRulesEditor;
  disabled: boolean;
}) {
  const inputId = useId();
  return (
    <LifecycleEventGroup
      catalog={editor.catalog}
      disabled={disabled}
      inputId={inputId}
      onCorrelationPathChange={editor.setCorrelationPath}
      onEventNamesChange={
        role === "start" ? editor.setStartEvents : editor.setCancelEvents
      }
      onFilterChange={
        role === "start" ? editor.setStartFilter : editor.setCancelFilter
      }
      onFilterChangeForAll={
        role === "start"
          ? editor.setStartFilterForAll
          : editor.setCancelFilterForAll
      }
      role={role}
      rules={editor.rules}
    />
  );
}

/** One Connection picker per integration a Lifecycle Event arrives through. */
export function LifecycleEventConnections({
  editor,
  disabled,
}: {
  editor: LifecycleRulesEditor;
  disabled: boolean;
}) {
  const { rules, catalog } = editor;
  return uniqueIntegrationsOfEvents(catalog, [
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
        editor.setConnectionId(integration, connectionId)
      }
    />
  ));
}
