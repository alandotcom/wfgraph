import { Checkbox } from "#src/components/ui/checkbox";
import { Label } from "#src/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#src/components/ui/select";
import {
  type ExtensionCatalog,
  findEntity,
  findEvent,
} from "@wfgraph/shared/extensions/catalog";
import {
  entityBindingChoices,
  reconcileEntityBindings,
} from "@wfgraph/shared/lifecycle/entity-eligibility";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { compact, uniq } from "es-toolkit/array";
import { omit } from "es-toolkit/object";
import { lowerFirst } from "es-toolkit/string";
import { toast } from "sonner";
import { getEntityConditionFields } from "#src/lib/upstream-node-fields";
import { whenChosen } from "#src/lib/select-choice";
import { lifecycleRuleTargetId } from "#src/components/workflow/canvas-reveal/lifecycle-reveal-model";
import { ConditionBuilderRow } from "./condition-builder-row";
import { ConfigGroup, ConfigHelp, RemoveGroupButton } from "./config-section";
import { lifecycleCheckFieldKey } from "#src/lib/required-field-errors";
import { FieldIssueMessages, useFieldRevealed } from "./field-issues";
import type { LifecycleRuleGroupProps } from "./use-lifecycle-rules-editor";
import {
  START_RULE_NAMES,
  trackedEntityLabel,
} from "./lifecycle-policy-summary";

const CHECKPOINTS = [
  {
    value: "before-execution" as const,
    label: "Before starting a run",
    description: "If the Entity is not eligible, no run starts.",
  },
  {
    value: "before-node" as const,
    label: "Before each step",
    description:
      "If the Entity is no longer eligible, the run ends before the next step.",
  },
];

type EntityEligibilityCheckpoint = (typeof CHECKPOINTS)[number]["value"];

function lifecycleEvents(rules: LifecycleRules): string[] {
  return uniq([...rules.startEvents, ...rules.cancelEvents]);
}

/**
 * One Lifecycle Event's binding of the tracked Entity, where it needs a person:
 * a picker when the Event offers several bindings, or a warning when it offers
 * none. An Event with exactly one binding draws nothing here, and the group's
 * help names the binding it uses.
 */
function EventBindingRow({
  catalog,
  disabled,
  entityLabel,
  entityType,
  eventName,
  selectedBinding,
  onChange,
}: {
  catalog: ExtensionCatalog;
  disabled: boolean;
  entityLabel: string;
  entityType: string;
  eventName: string;
  selectedBinding: string | undefined;
  onChange: (bindingName: string) => void;
}) {
  const event = findEvent(catalog, eventName);
  const choices = entityBindingChoices({ catalog, eventName, entityType });
  const label = event?.label ?? eventName;

  if (choices.length === 0) {
    return (
      <p className="text-warning text-xs">
        {label} cannot identify the {entityLabel}. Add a compatible binding to
        this event in the host app.
      </p>
    );
  }

  if (choices.length === 1) {
    return null;
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={`entity-binding-${eventName}`}>
        {entityLabel} ID in {label}
      </Label>
      <Select
        disabled={disabled}
        items={choices.map((choice) => ({
          label: choice.name,
          value: choice.name,
        }))}
        onValueChange={whenChosen(onChange)}
        value={selectedBinding ?? null}
      >
        <SelectTrigger
          aria-label={`${entityLabel} ID in ${label}`}
          className="w-full"
          id={`entity-binding-${eventName}`}
        >
          <SelectValue placeholder="Choose ID binding" />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.name} value={choice.name}>
              {choice.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The sentence naming the one binding an Event uses for the tracked Entity,
 * for the group's help, or null when the Event offers several or none.
 */
function singleBindingSentence(input: {
  catalog: ExtensionCatalog;
  entityLabel: string;
  entityType: string;
  eventName: string;
}): string | null {
  const choices = entityBindingChoices(input);
  const [only] = choices;
  if (choices.length !== 1 || !only) {
    return null;
  }
  const label = findEvent(input.catalog, input.eventName)?.label;
  return `${label ?? input.eventName} uses the ${only.name} binding to get the ${input.entityLabel} ID.`;
}

function UnavailableEntityNote({
  catalog,
  events,
  compatibleEntityTypes,
}: {
  catalog: ExtensionCatalog;
  events: string[];
  compatibleEntityTypes: Set<string>;
}) {
  const unavailable = catalog.entities.flatMap((entity) => {
    if (compatibleEntityTypes.has(entity.type)) {
      return [];
    }
    const missingEvents = events
      .filter(
        (eventName) =>
          entityBindingChoices({
            catalog,
            eventName,
            entityType: entity.type,
          }).length === 0
      )
      .map((eventName) => findEvent(catalog, eventName)?.label ?? eventName);
    return missingEvents.length > 0 ? [{ entity, missingEvents }] : [];
  });

  if (unavailable.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1">
      <p>
        Only Entities identified by every start and Cancel Event are offered.
      </p>
      <ul className="list-disc space-y-0.5 pl-4">
        {unavailable.map(({ entity, missingEvents }) => (
          <li key={entity.type}>
            {entity.label} is unavailable because {missingEvents.join(", ")}{" "}
            cannot identify it.
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * When Entity Eligibility is checked: before a run starts, before each step, or
 * both. Renders nothing while the rules hold no eligibility rule.
 */
function LifecycleEligibilityCheckpoints({
  rules,
  catalog,
  disabled,
  onChange,
}: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
  disabled: boolean;
  onChange: (rules: LifecycleRules) => void;
}) {
  const eligibility = rules.entityEligibility;
  if (!eligibility) {
    return null;
  }
  const entityLabel = trackedEntityLabel(rules, catalog) ?? "Entity";

  const setCheckpoint = (
    checkpoint: EntityEligibilityCheckpoint,
    checked: boolean
  ) => {
    onChange({
      ...rules,
      entityEligibility: {
        ...eligibility,
        checkpoints: checked
          ? uniq([...eligibility.checkpoints, checkpoint])
          : eligibility.checkpoints.filter((value) => value !== checkpoint),
      },
    });
  };

  return (
    <fieldset className="space-y-2">
      <div className="flex items-center gap-1">
        <legend className="font-medium text-xs">When to check</legend>
        <ConfigHelp label="When to check">
          {CHECKPOINTS.map((checkpoint) => (
            <p key={checkpoint.value}>
              <span className="font-medium text-foreground">
                {checkpoint.label}
              </span>{" "}
              {checkpoint.description.replace(
                "the Entity",
                `the ${entityLabel}`
              )}
            </p>
          ))}
        </ConfigHelp>
      </div>
      {CHECKPOINTS.map((checkpoint) => {
        const inputId = `entity-eligibility-${checkpoint.value}`;
        return (
          <div className="flex items-center gap-2" key={checkpoint.value}>
            <Checkbox
              checked={eligibility.checkpoints.includes(checkpoint.value)}
              disabled={disabled}
              id={inputId}
              onCheckedChange={(checked) =>
                setCheckpoint(checkpoint.value, checked)
              }
            />
            <Label htmlFor={inputId}>{checkpoint.label}</Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * "One run per": the tracked Entity, its binding in each Lifecycle Event, the
 * eligibility rule over its current state ("Only while the patient matches",
 * named for the Entity), and when that rule is checked. Explanations sit
 * behind the label's info icon, and a refusal Publish would give shows beneath
 * the controls. With `onRemove`, the label row offers Remove, which stops
 * tracking and drops the eligibility rule.
 */
export function LifecycleEntityEligibilityGroup({
  editor,
  section,
  disabled,
  onRemove,
}: LifecycleRuleGroupProps<"entity-eligibility">) {
  const { rules, catalog, setRules: onChange } = editor;
  const revealUnfinished = useFieldRevealed(
    lifecycleCheckFieldKey("entity_eligibility")
  );
  const tracked = rules.trackedEntity;
  const eligibility = rules.entityEligibility;
  const entity = tracked ? findEntity(catalog, tracked.type) : undefined;
  const entityLabel = entity?.label ?? tracked?.type ?? "Entity";
  const entityFields = tracked
    ? getEntityConditionFields(catalog, tracked.type)
    : [];
  const events = lifecycleEvents(rules);
  const compatibleEntities =
    events.length > 0
      ? catalog.entities.filter((candidate) =>
          events.every(
            (eventName) =>
              entityBindingChoices({
                catalog,
                eventName,
                entityType: candidate.type,
              }).length > 0
          )
        )
      : [];
  const compatibleEntityTypes = new Set(
    compatibleEntities.map((candidate) => candidate.type)
  );
  const bindingSentences = tracked
    ? compact(
        events.map((eventName) =>
          singleBindingSentence({
            catalog,
            entityLabel,
            entityType: tracked.type,
            eventName,
          })
        )
      )
    : [];

  const selectEntity = (entityType: string) => {
    if (entityType === tracked?.type) {
      return;
    }
    onChange(
      reconcileEntityBindings(
        {
          ...omit(rules, ["entityEligibility"]),
          trackedEntity: { type: entityType, bindings: {} },
        },
        catalog
      )
    );
    if (eligibility) {
      toast("Eligibility rule cleared", {
        description: "Set a rule for the newly selected Entity.",
      });
    }
    if (rules.correlationPaths) {
      toast("Correlation Paths cleared", {
        description: "Entity tracking replaces Correlation Paths.",
      });
    }
  };

  const updateBinding = (eventName: string, bindingName: string) => {
    if (!tracked) {
      return;
    }
    onChange({
      ...rules,
      trackedEntity: {
        ...tracked,
        bindings: Object.fromEntries([
          ...Object.entries(tracked.bindings).filter(
            ([name]) => name !== eventName
          ),
          [eventName, bindingName],
        ]),
      },
    });
  };

  const entityPicker = (
    <Select
      disabled={disabled}
      items={compatibleEntities.map((item) => ({
        label: item.label,
        value: item.type,
      }))}
      onValueChange={whenChosen(selectEntity)}
      value={
        tracked && compatibleEntityTypes.has(tracked.type) ? tracked.type : null
      }
    >
      <SelectTrigger
        aria-invalid={
          tracked
            ? !entity || !compatibleEntityTypes.has(tracked.type)
            : undefined
        }
        aria-label={START_RULE_NAMES.entity}
        className="w-full"
        id={lifecycleRuleTargetId(section)}
      >
        <SelectValue placeholder={tracked ? entityLabel : "Choose an Entity"} />
      </SelectTrigger>
      <SelectContent>
        {compatibleEntities.map((item) => (
          <SelectItem key={item.type} value={item.type}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <ConfigGroup
      help={
        <>
          <p>
            Runs with the same Entity ID are related, for overlapping runs and
            Cancel Events. Steps cannot use this Entity data.
          </p>
          {bindingSentences.length > 0 ? (
            <p>{bindingSentences.join(" ")}</p>
          ) : null}
          <UnavailableEntityNote
            catalog={catalog}
            compatibleEntityTypes={compatibleEntityTypes}
            events={events}
          />
        </>
      }
      label={START_RULE_NAMES.entity}
      prominent
      trailing={
        onRemove ? (
          <RemoveGroupButton
            disabled={disabled}
            label={START_RULE_NAMES.entity}
            onRemove={onRemove}
          />
        ) : null
      }
    >
      {tracked || compatibleEntities.length > 0 ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            {entityPicker}
            {tracked && !entity ? (
              <p className="text-warning text-xs" role="alert">
                {entityLabel} is no longer available. Choose an Entity this app
                declares, or ask the host to restore it.
              </p>
            ) : null}
            {tracked && events.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                Add a Start Event before tracking an Entity.
              </p>
            ) : null}
            {tracked
              ? events.map((eventName) => (
                  <EventBindingRow
                    catalog={catalog}
                    disabled={disabled}
                    entityLabel={entityLabel}
                    entityType={tracked.type}
                    eventName={eventName}
                    key={eventName}
                    onChange={(bindingName) =>
                      updateBinding(eventName, bindingName)
                    }
                    selectedBinding={tracked.bindings[eventName]}
                  />
                ))
              : null}
          </div>

          {tracked ? (
            <ConditionBuilderRow
              description={`Checks current ${entityLabel} data from your app before a run starts or before each step.`}
              disabled={disabled}
              emptyFieldsMessage={`The ${entityLabel} has no fields available for an eligibility rule.`}
              fields={entityFields}
              label={`Only while the ${lowerFirst(entityLabel)} matches`}
              revealUnfinished={revealUnfinished}
              // Entity Eligibility refuses a set comparison on a string field
              // with no enum values, so the builder does not offer one.
              setOperatorsRequireEnumValues
              onChange={({ model }) =>
                onChange(
                  model === ""
                    ? omit(rules, ["entityEligibility"])
                    : {
                        ...rules,
                        entityEligibility: {
                          condition: model,
                          checkpoints: eligibility?.checkpoints ?? [
                            "before-execution",
                            "before-node",
                          ],
                        },
                      }
                )
              }
              value={eligibility?.condition ?? ""}
            />
          ) : null}

          <LifecycleEligibilityCheckpoints
            catalog={catalog}
            disabled={disabled}
            onChange={onChange}
            rules={rules}
          />

          <FieldIssueMessages
            fieldKey={lifecycleCheckFieldKey("entity_eligibility")}
          />
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          {events.length === 0
            ? "Add a Start Event before tracking an Entity."
            : "No Entity can be tracked because the start and Cancel Events do not share a compatible Entity binding."}
        </p>
      )}
    </ConfigGroup>
  );
}
