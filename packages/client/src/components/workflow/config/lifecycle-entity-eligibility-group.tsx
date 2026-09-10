import { X } from "lucide-react";
import { Button } from "#src/components/ui/button";
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
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { omit } from "es-toolkit/object";
import { uniq } from "es-toolkit/array";
import { getEntityConditionFields } from "#src/lib/upstream-node-fields";
import { whenChosen } from "#src/lib/select-choice";
import { ConditionBuilderRow } from "./condition-builder-row";
import { ConfigGroup } from "./config-section";

const CHECKPOINTS = [
  {
    value: "before-execution" as const,
    label: "Before opening an Execution",
    description:
      "Runs after the Start Filter and before Concurrency. Ineligible arrivals open no Execution.",
  },
  {
    value: "before-node" as const,
    label: "Before each workflow node",
    description:
      "Checks every enabled executable node on the Started side. Ineligible runs exit before the node starts.",
  },
];

type EntityEligibilityCheckpoint = (typeof CHECKPOINTS)[number]["value"];

function lifecycleEvents(rules: LifecycleRules): string[] {
  return uniq([...rules.startEvents, ...rules.cancelEvents]);
}

function bindingChoices(input: {
  catalog: ExtensionCatalog;
  eventName: string;
  entityType: string;
}) {
  return (
    findEvent(input.catalog, input.eventName)?.entityBindings ?? []
  ).filter((binding) => binding.entityType === input.entityType);
}

/** Keeps one selected binding for each current Lifecycle Event when possible. */
export function reconcileEntityBindings(
  rules: LifecycleRules,
  catalog: ExtensionCatalog
): LifecycleRules {
  const tracked = rules.trackedEntity;
  if (!tracked) {
    return rules;
  }

  const bindings = Object.fromEntries(
    lifecycleEvents(rules).flatMap((eventName) => {
      const choices = bindingChoices({
        catalog,
        eventName,
        entityType: tracked.type,
      });
      const selected = choices.some(
        (choice) => choice.name === tracked.bindings[eventName]
      )
        ? tracked.bindings[eventName]
        : choices[0]?.name;
      return selected ? [[eventName, selected]] : [];
    })
  );

  return {
    ...rules,
    trackedEntity: { type: tracked.type, bindings },
  };
}

function EventBindingRow({
  catalog,
  disabled,
  entityType,
  eventName,
  selectedBinding,
  onChange,
}: {
  catalog: ExtensionCatalog;
  disabled: boolean;
  entityType: string;
  eventName: string;
  selectedBinding: string | undefined;
  onChange: (bindingName: string) => void;
}) {
  const event = findEvent(catalog, eventName);
  const choices = bindingChoices({ catalog, eventName, entityType });
  const label = event?.label ?? eventName;

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={`entity-binding-${eventName}`}>{label}</Label>
      <Select
        disabled={disabled || choices.length === 0}
        items={choices.map((choice) => ({
          label: choice.name,
          value: choice.name,
        }))}
        onValueChange={whenChosen(onChange)}
        value={selectedBinding ?? null}
      >
        <SelectTrigger
          aria-label={`Entity binding for ${label}`}
          className="w-full"
          id={`entity-binding-${eventName}`}
        >
          <SelectValue
            placeholder={
              choices.length === 0 ? "No compatible binding" : "Choose binding"
            }
          />
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

export function LifecycleEntityEligibilityGroup({
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
  const tracked = rules.trackedEntity;
  const eligibility = rules.entityEligibility;
  const entity = tracked ? findEntity(catalog, tracked.type) : undefined;
  const entityFields = tracked
    ? getEntityConditionFields(catalog, tracked.type)
    : [];
  const events = lifecycleEvents(rules);
  const compatibleEntities =
    events.length > 0
      ? catalog.entities.filter((candidate) =>
          events.every(
            (eventName) =>
              bindingChoices({
                catalog,
                eventName,
                entityType: candidate.type,
              }).length > 0
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
          ...rules,
          trackedEntity: { type: entityType, bindings: {} },
          entityEligibility: {
            condition: "",
            checkpoints: ["before-execution", "before-node"],
          },
        },
        catalog
      )
    );
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

  const setCheckpoint = (
    checkpoint: EntityEligibilityCheckpoint,
    checked: boolean
  ) => {
    if (!eligibility) {
      return;
    }
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
    <ConfigGroup
      className="py-3 first:pt-0 last:pb-0"
      help={
        <>
          <p>The host resolves current Entity State for this rule.</p>
          <p>Payload Start Filters run separately before an admission check.</p>
          <p>Resolved State is never available to workflow steps.</p>
        </>
      }
      label="Entity eligibility"
    >
      {tracked && eligibility ? (
        <div className="space-y-3">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="tracked-entity">Tracked Entity</Label>
              <Select
                disabled={disabled}
                items={compatibleEntities.map((item) => ({
                  label: item.label,
                  value: item.type,
                }))}
                onValueChange={whenChosen(selectEntity)}
                value={
                  compatibleEntities.some((item) => item.type === tracked.type)
                    ? tracked.type
                    : null
                }
              >
                <SelectTrigger className="w-full" id="tracked-entity">
                  <SelectValue placeholder={tracked.type} />
                </SelectTrigger>
                <SelectContent>
                  {compatibleEntities.map((item) => (
                    <SelectItem key={item.type} value={item.type}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              aria-label="Remove Entity eligibility"
              disabled={disabled}
              onClick={() =>
                onChange(omit(rules, ["trackedEntity", "entityEligibility"]))
              }
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <X />
            </Button>
          </div>

          {events.length > 0 ? (
            <div className="space-y-2 rounded-md border px-3 py-2">
              <p className="font-medium text-xs">Event bindings</p>
              {events.map((eventName) => (
                <EventBindingRow
                  catalog={catalog}
                  disabled={disabled}
                  entityType={tracked.type}
                  eventName={eventName}
                  key={eventName}
                  onChange={(bindingName) =>
                    updateBinding(eventName, bindingName)
                  }
                  selectedBinding={tracked.bindings[eventName]}
                />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              Choose a Start Event before configuring Entity bindings.
            </p>
          )}

          <ConditionBuilderRow
            description={`Uses current ${entity?.label ?? tracked.type} State from the host. Resolved State is not stored.`}
            disabled={disabled}
            editActionName="Eligibility condition"
            emptyFieldsMessage="This Entity declares no fields that an Eligibility condition can compare."
            fields={entityFields}
            label="Eligible when"
            onChange={({ model }) =>
              onChange({
                ...rules,
                entityEligibility: { ...eligibility, condition: model },
              })
            }
            value={eligibility.condition}
          />

          <fieldset className="space-y-2">
            <legend className="font-medium text-xs">Evaluate</legend>
            {CHECKPOINTS.map((checkpoint) => {
              const inputId = `entity-eligibility-${checkpoint.value}`;
              return (
                <div className="flex items-start gap-2" key={checkpoint.value}>
                  <Checkbox
                    checked={eligibility.checkpoints.includes(checkpoint.value)}
                    className="mt-0.5"
                    disabled={disabled}
                    id={inputId}
                    onCheckedChange={(checked) =>
                      setCheckpoint(checkpoint.value, checked)
                    }
                  />
                  <div className="space-y-0.5">
                    <Label htmlFor={inputId}>{checkpoint.label}</Label>
                    <p className="text-muted-foreground text-xs">
                      {checkpoint.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </fieldset>
        </div>
      ) : compatibleEntities.length > 0 ? (
        <div className="space-y-2">
          <Select
            disabled={disabled}
            items={compatibleEntities.map((item) => ({
              label: item.label,
              value: item.type,
            }))}
            onValueChange={whenChosen(selectEntity)}
            value={null}
          >
            <SelectTrigger aria-label="Tracked Entity" className="w-full">
              <SelectValue placeholder="Choose an Entity" />
            </SelectTrigger>
            <SelectContent>
              {compatibleEntities.map((item) => (
                <SelectItem key={item.type} value={item.type}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            Optional. Guard starts or workflow nodes with current host state.
          </p>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          {events.length === 0
            ? "Choose a Start Event before adding Entity eligibility."
            : "Current Lifecycle Events do not share a host-defined Entity type."}
        </p>
      )}
    </ConfigGroup>
  );
}
