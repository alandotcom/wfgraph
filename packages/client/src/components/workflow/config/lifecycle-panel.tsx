import { uniq } from "es-toolkit/array";
import { ChevronDown, Plus } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "#src/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#src/components/ui/dropdown-menu";
import {
  LIFECYCLE_ADD_RULE_ID,
  type LifecycleRuleChoice,
  type LifecycleSectionId,
  lifecycleRuleTargetId,
  lifecycleSectionShown,
  offeredLifecycleRules,
  type RemovableLifecycleSection,
  withoutLifecycleRule,
} from "#src/components/workflow/canvas-reveal/lifecycle-reveal-model";
import { uniqueIntegrationsOfEvents } from "@wfgraph/shared/extensions/catalog";
import {
  connectionIdForIntegration,
  type LifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { ConfigGroup } from "./config-section";
import { IntegrationEventConnectionEditor } from "./integration-event-connection";
import {
  LifecycleConcurrencyGroup,
  LifecycleManualStartGroup,
} from "./lifecycle-concurrency-group";
import { LifecycleEntityEligibilityGroup } from "./lifecycle-entity-eligibility-group";
import { LifecycleEventGroup } from "./lifecycle-event-group";
import { LifecycleScheduleGroup } from "./lifecycle-schedule-group";
import type { UpdateNodeConfig } from "./node-config-patch";
import {
  type LifecycleRulesEditor,
  useLifecycleRulesEditor,
} from "./use-lifecycle-rules-editor";

export { CONCURRENCY_OPTIONS } from "./lifecycle-policy-summary";

/**
 * The Start's one form: every rule the start has set, each as its controls
 * under one label, always editable, with "Add a rule" at the end. "Starts
 * when" and "Can be run by hand" always show; any other rule shows once it is
 * set (`lifecycleSectionShown`) or once a person adds it from "Add a rule",
 * which shows its controls in place before they hold a value. Every control
 * writes the complete Lifecycle Rules object, and opening the form persists
 * nothing.
 *
 * `focusTarget` moves focus to an element by id without scrolling anything
 * that does not have to: into a rule a person just added, and to "Add a rule"
 * after a Remove. A Publish refusal shows beneath the rule its check reads
 * when the form sits inside a `FieldIssuesProvider`.
 */
export function LifecyclePanel({
  config,
  onUpdateConfig,
  disabled,
  focusTarget,
}: {
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled: boolean;
  focusTarget?: ((targetId: string) => void) | undefined;
}) {
  const editor = useLifecycleRulesEditor({ config, onUpdateConfig });
  const { rules, catalog } = editor;
  // Rules a person added from "Add a rule" that may hold no value yet. Each
  // shows until it is removed, so its controls do not vanish while empty.
  const [added, setAdded] = useState<readonly LifecycleSectionId[]>([]);
  const shown = (section: LifecycleSectionId) =>
    added.includes(section) ||
    lifecycleSectionShown({ section, rules, catalog, issueCount: 0 });
  const removeRule = (section: RemovableLifecycleSection) =>
    disabled
      ? undefined
      : () => {
          editor.setRules(withoutLifecycleRule(rules, section));
          setAdded(added.filter((entry) => entry !== section));
          focusTarget?.(LIFECYCLE_ADD_RULE_ID);
        };
  const addRule = (choice: LifecycleRuleChoice) => {
    setAdded(uniq([...added, choice.section]));
    focusTarget?.(
      lifecycleRuleTargetId(
        choice.id === "start-filter" ? "start-filter" : choice.section
      )
    );
  };

  return (
    <div className="space-y-5">
      <LifecycleRoleEventGroup
        disabled={disabled}
        editor={editor}
        firstFilterButtonId={lifecycleRuleTargetId("start-filter")}
        inputId={lifecycleRuleTargetId("start-events")}
        role="start"
      />
      {shown("entity-eligibility") ? (
        <LifecycleEntityEligibilityGroup
          catalog={catalog}
          disabled={disabled}
          onChange={editor.setRules}
          onRemove={removeRule("entity-eligibility")}
          rules={rules}
          selectId={lifecycleRuleTargetId("entity-eligibility")}
        />
      ) : null}
      {shown("overlapping-runs") ? (
        <LifecycleConcurrencyGroup
          disabled={disabled}
          onConcurrencyChange={editor.setConcurrency}
          onRemove={removeRule("overlapping-runs")}
          rules={rules}
          triggerId={lifecycleRuleTargetId("overlapping-runs")}
        />
      ) : null}
      {shown("schedule") ? (
        <LifecycleScheduleGroup
          addButtonId={lifecycleRuleTargetId("schedule")}
          disabled={disabled}
          onRemove={removeRule("schedule")}
          schedules={editor.schedules}
        />
      ) : null}
      {shown("cancel-events") ? (
        <LifecycleRoleEventGroup
          disabled={disabled}
          editor={editor}
          inputId={lifecycleRuleTargetId("cancel-events")}
          onRemove={removeRule("cancel-events")}
          role="cancel"
        />
      ) : null}
      {shown("connections") ? (
        <ConfigGroup
          help={
            <p>
              An Event from an integration reaches no run until its Connection
              is chosen.
            </p>
          }
          label="Event Connections"
          prominent
        >
          <div className="space-y-3">
            <LifecycleEventConnections disabled={disabled} editor={editor} />
          </div>
        </ConfigGroup>
      ) : null}
      {disabled ? null : (
        <AddRuleMenu
          exclude={added}
          onChoose={addRule}
          rules={rules}
          triggerId={LIFECYCLE_ADD_RULE_ID}
        />
      )}
    </div>
  );
}

const NO_SECTIONS: readonly LifecycleSectionId[] = [];

/**
 * "Add a rule": each rule not set yet, named for what it does. A rule whose
 * section `exclude` names is left out, since its controls already show.
 */
export function AddRuleMenu({
  rules,
  onChoose,
  exclude = NO_SECTIONS,
  triggerId,
}: {
  rules: LifecycleRules;
  onChoose: (choice: LifecycleRuleChoice) => void;
  exclude?: readonly LifecycleSectionId[] | undefined;
  triggerId?: string | undefined;
}) {
  const offered = offeredLifecycleRules(rules).filter(
    (choice) => !exclude.includes(choice.section)
  );
  if (offered.length === 0) {
    return null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            className="-ml-2 text-muted-foreground"
            id={triggerId}
            size="sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <Plus data-icon="inline-start" />
        Add a rule
        <ChevronDown className="size-3 opacity-50" data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {offered.map((choice) => (
          <DropdownMenuItem key={choice.id} onClick={() => onChoose(choice)}>
            {choice.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The Start or Cancel Events group, writing through one Lifecycle Rules
 * editor. The start role also holds whether a person may run it by hand,
 * since both answer what starts a run. `inputId` names the Event picker, and
 * `onRemove`, when given, offers Remove on the label row.
 */
export function LifecycleRoleEventGroup({
  role,
  editor,
  disabled,
  inputId,
  onRemove,
  firstFilterButtonId,
}: {
  role: "start" | "cancel";
  editor: LifecycleRulesEditor;
  disabled: boolean;
  inputId?: string | undefined;
  onRemove?: (() => void) | undefined;
  firstFilterButtonId?: string | undefined;
}) {
  const generatedId = useId();
  const events = (
    <LifecycleEventGroup
      catalog={editor.catalog}
      disabled={disabled}
      firstFilterButtonId={firstFilterButtonId}
      inputId={inputId ?? generatedId}
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
      onRemove={onRemove}
      role={role}
      rules={editor.rules}
    />
  );
  return role === "start" ? (
    <div className="space-y-3">
      {events}
      <LifecycleManualStartGroup
        disabled={disabled}
        onManualStartChange={editor.setManualStart}
        rules={editor.rules}
      />
    </div>
  ) : (
    events
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
