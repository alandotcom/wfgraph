import { uniq } from "es-toolkit/array";
import { ChevronDown, Plus } from "lucide-react";
import { useState } from "react";
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
  lifecycleRuleIsSet,
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
  type LifecycleRuleGroupProps,
  useLifecycleRulesEditor,
} from "./use-lifecycle-rules-editor";

export { CONCURRENCY_OPTIONS } from "./lifecycle-policy-summary";

/**
 * The rules a person chose from "Add a rule" whose controls show before they
 * hold a value, with the stored rules value they were last checked against.
 * `stored` is the `lifecycleRules` value of the config at the form's last own
 * write or choice, so a different value there means a write from outside the
 * form, such as Undo or the build agent, replaced the rules since.
 */
type AddedRules = {
  stored: unknown;
  choices: readonly LifecycleRuleChoice[];
};

/**
 * The Start's one form: every rule the start has set, each as its controls
 * under one label, always editable, with "Add a rule" at the end. "Starts
 * when" and "Can be run by hand" always show; any other rule shows once it is
 * set (`lifecycleSectionShown`) or once a person adds it from "Add a rule",
 * which shows its controls in place before they hold a value. A rule added
 * that way stays while the person empties it again, and leaves once a write
 * from outside the form, such as Undo or the build agent, leaves it unset.
 * Every control writes the complete Lifecycle Rules object, and opening the
 * form persists nothing.
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
  const stored = config.lifecycleRules;
  const [added, setAdded] = useState<AddedRules>({ stored, choices: [] });
  const editor = useLifecycleRulesEditor({
    config,
    onUpdateConfig: (patch) => {
      // The form's own write keeps every added rule, set or not.
      setAdded({ stored: patch.lifecycleRules, choices: addedChoices });
      onUpdateConfig(patch);
    },
  });
  const { rules, catalog } = editor;
  const addedChoices =
    added.stored === stored
      ? added.choices
      : added.choices.filter((choice) => lifecycleRuleIsSet(choice, rules));
  const shown = (section: LifecycleSectionId) =>
    addedChoices.some((choice) => choice.section === section) ||
    lifecycleSectionShown({ section, rules, catalog });
  const removeRule = (section: RemovableLifecycleSection) =>
    disabled
      ? undefined
      : () => {
          editor.setRules(withoutLifecycleRule(rules, section));
          setAdded((current) => ({
            ...current,
            choices: current.choices.filter(
              (choice) => choice.section !== section
            ),
          }));
          focusTarget?.(LIFECYCLE_ADD_RULE_ID);
        };
  const addRule = (choice: LifecycleRuleChoice) => {
    // "Starts when" always shows, so a choice it edits, such as a Start
    // Filter, only moves focus, and stays offered until its rule is set.
    if (choice.section !== "start-events") {
      setAdded({ stored, choices: uniq([...addedChoices, choice]) });
    }
    focusTarget?.(choice.targetId);
  };

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <LifecycleEventGroup
          disabled={disabled}
          editor={editor}
          section="start-events"
        />
        <LifecycleManualStartGroup disabled={disabled} editor={editor} />
      </div>
      {shown("entity-eligibility") ? (
        <LifecycleEntityEligibilityGroup
          disabled={disabled}
          editor={editor}
          onRemove={removeRule("entity-eligibility")}
          section="entity-eligibility"
        />
      ) : null}
      {shown("overlapping-runs") ? (
        <LifecycleConcurrencyGroup
          disabled={disabled}
          editor={editor}
          onRemove={removeRule("overlapping-runs")}
          section="overlapping-runs"
        />
      ) : null}
      {shown("schedule") ? (
        <LifecycleScheduleGroup
          disabled={disabled}
          editor={editor}
          onRemove={removeRule("schedule")}
          section="schedule"
        />
      ) : null}
      {shown("cancel-events") ? (
        <LifecycleEventGroup
          disabled={disabled}
          editor={editor}
          onRemove={removeRule("cancel-events")}
          section="cancel-events"
        />
      ) : null}
      {shown("connections") ? (
        <LifecycleConnectionsGroup
          disabled={disabled}
          editor={editor}
          section="connections"
        />
      ) : null}
      {disabled ? null : (
        <AddRuleMenu
          exclude={addedChoices}
          onChoose={addRule}
          rules={rules}
          triggerId={LIFECYCLE_ADD_RULE_ID}
        />
      )}
    </div>
  );
}

/**
 * "Add a rule": each rule not set yet, named for what it does, leaving out
 * the choices `exclude` names, whose controls already show.
 */
function AddRuleMenu({
  rules,
  onChoose,
  exclude,
  triggerId,
}: {
  rules: LifecycleRules;
  onChoose: (choice: LifecycleRuleChoice) => void;
  exclude: readonly LifecycleRuleChoice[];
  triggerId: string;
}) {
  const offered = offeredLifecycleRules(rules).filter(
    (choice) => !exclude.some((entry) => entry.id === choice.id)
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
 * Event Connections: one Connection picker per integration a Start or Cancel
 * Event arrives through, since such an Event reaches no run until its
 * Connection is chosen.
 */
function LifecycleConnectionsGroup({
  editor,
  disabled,
}: LifecycleRuleGroupProps<"connections">) {
  const { rules, catalog } = editor;
  return (
    <ConfigGroup
      help={
        <p>
          An Event from an integration reaches no run until its Connection is
          chosen.
        </p>
      }
      label="Event Connections"
      prominent
    >
      <div className="space-y-3">
        {uniqueIntegrationsOfEvents(catalog, [
          ...rules.startEvents,
          ...rules.cancelEvents,
        ]).map((integration) => (
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
              editor.setConnectionId(integration, connectionId)
            }
          />
        ))}
      </div>
    </ConfigGroup>
  );
}
