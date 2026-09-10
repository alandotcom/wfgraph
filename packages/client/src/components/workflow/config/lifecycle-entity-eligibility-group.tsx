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
import { checkEntityEligibility } from "@wfgraph/shared/lifecycle/entity-eligibility";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { uniq } from "es-toolkit/array";
import { omit } from "es-toolkit/object";
import { toast } from "sonner";
import { getEntityConditionFields } from "#src/lib/upstream-node-fields";
import { whenChosen } from "#src/lib/select-choice";
import { ConditionBuilderRow } from "./condition-builder-row";
import { ConfigGroup } from "./config-section";

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
  const choices = bindingChoices({ catalog, eventName, entityType });
  const label = event?.label ?? eventName;

  if (choices.length === 0) {
    return (
      <div className="space-y-1">
        <p className="font-medium text-xs">{label}</p>
        <p className="text-warning text-xs">
          {label} cannot identify the {entityLabel}. Add a compatible binding to
          this event in the host app.
        </p>
      </div>
    );
  }

  if (choices.length === 1) {
    return (
      <div className="space-y-0.5 text-xs">
        <p className="break-words font-medium">{label}</p>
        <p className="break-words text-muted-foreground">
          Uses {choices[0]?.name} automatically
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={`entity-binding-${eventName}`}>
        {entityLabel} in {label}
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
          aria-label={`${entityLabel} in ${label}`}
          className="w-full"
          id={`entity-binding-${eventName}`}
        >
          <SelectValue placeholder="Choose binding" />
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
          bindingChoices({
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
    <div className="space-y-1 text-muted-foreground text-xs">
      <p>Only Entities identified by every lifecycle event are shown.</p>
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
              bindingChoices({
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
  const configurationCheck = checkEntityEligibility({ rules, catalog });

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

  const removeTracking = () => {
    onChange(omit(rules, ["trackedEntity", "entityEligibility"]));
    toast("Tracking and eligibility removed", {
      description: "Use Actions > Undo to restore it.",
    });
  };

  return (
    <ConfigGroup
      className="py-3 first:pt-0 last:pb-0"
      help={
        <>
          <p>
            Tracking identifies which Entity a lifecycle event belongs to.
            Overlapping runs and cancellation use this identity.
          </p>
          <p>
            Eligibility can check the latest Entity data before a run starts or
            before each step.
          </p>
          <p>Resolved data is not stored or available to steps.</p>
        </>
      }
      label={
        tracked
          ? `${entityLabel} tracking and eligibility`
          : "Tracking and eligibility"
      }
      prominent
    >
      {tracked ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tracked-entity">Track runs by</Label>
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
              <SelectTrigger
                aria-invalid={
                  !entity || !compatibleEntityTypes.has(tracked.type)
                }
                aria-label="Track runs by"
                className="w-full"
                id="tracked-entity"
              >
                <SelectValue placeholder={entityLabel} />
              </SelectTrigger>
              <SelectContent>
                {compatibleEntities.map((item) => (
                  <SelectItem key={item.type} value={item.type}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!entity ? (
              <p className="text-warning text-xs" role="alert">
                {entityLabel} is no longer available. Choose an Entity this app
                declares, or ask the host to restore it.
              </p>
            ) : null}
          </div>

          <UnavailableEntityNote
            catalog={catalog}
            compatibleEntityTypes={compatibleEntityTypes}
            events={events}
          />

          {events.length > 0 ? (
            <div className="space-y-2 rounded-md border px-3 py-2">
              <p className="font-medium text-xs">{entityLabel} in each event</p>
              {events.map((eventName) => (
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
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              Add a Start Event before tracking an Entity.
            </p>
          )}

          <ConditionBuilderRow
            description={`Workflow Graph checks the ${entityLabel}'s latest data from your app. This data is used only for eligibility. It is not stored or available to steps.`}
            disabled={disabled}
            editActionName="Eligibility rule"
            emptyFieldsMessage={`The ${entityLabel} has no fields available for an eligibility rule.`}
            fields={entityFields}
            label="Eligible when"
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

          {entity && !configurationCheck.valid ? (
            <p className="text-warning text-xs" role="alert">
              {configurationCheck.error}
            </p>
          ) : null}

          {eligibility ? (
            <fieldset className="space-y-2">
              <legend className="font-medium text-xs">When to check</legend>
              {CHECKPOINTS.map((checkpoint) => {
                const inputId = `entity-eligibility-${checkpoint.value}`;
                const description = checkpoint.description.replace(
                  "the Entity",
                  `the ${entityLabel}`
                );
                return (
                  <div
                    className="flex items-start gap-2"
                    key={checkpoint.value}
                  >
                    <Checkbox
                      checked={eligibility.checkpoints.includes(
                        checkpoint.value
                      )}
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
                        {description}
                      </p>
                    </div>
                  </div>
                );
              })}
            </fieldset>
          ) : null}

          <Button
            disabled={disabled}
            onClick={removeTracking}
            size="sm"
            type="button"
            variant="ghost"
          >
            Remove tracking and eligibility
          </Button>
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
            <SelectTrigger aria-label="Track runs by" className="w-full">
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
            Optional. Use an Entity to match overlapping runs and cancel events.
          </p>
          <UnavailableEntityNote
            catalog={catalog}
            compatibleEntityTypes={compatibleEntityTypes}
            events={events}
          />
        </div>
      ) : (
        <div className="space-y-2 text-muted-foreground text-xs">
          <p>
            {events.length === 0
              ? "Add a Start Event before tracking an Entity."
              : "No Entity can be tracked because the lifecycle events do not share a compatible Entity binding."}
          </p>
          <UnavailableEntityNote
            catalog={catalog}
            compatibleEntityTypes={compatibleEntityTypes}
            events={events}
          />
        </div>
      )}
    </ConfigGroup>
  );
}
