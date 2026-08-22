import { compact, uniq } from "es-toolkit";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  type ExtensionCatalog,
  findEvent,
} from "@wfgraph/shared/extensions/catalog";
import {
  checkLifecycleRules,
  type Concurrency,
  correlationPathRequestFor,
  type CorrelationPathRequest,
  initialLifecycleRules,
  type LifecycleRules,
  pruneCorrelationPaths,
  readLifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { EventMultiCombobox } from "./event-combobox";
import type { UpdateNodeConfig } from "./node-config-patch";

/**
 * The Lifecycle Node's panel: what starts a run of this workflow, and what
 * happens to the runs already going (ADR-0007).
 *
 * The rules are one object on the entry node's config, so every control here
 * writes the whole of it. Reads fall back to `initialLifecycleRules` rather than
 * writing them on mount: opening a panel is not an edit, and an autosave nobody
 * asked for is how a builder loses the difference between "never configured" and
 * "configured this way".
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
  const startEventId = "lifecycle-start-events";
  const cancelEventsId = "lifecycle-cancel-events";
  const catalog = useExtensionCatalog();
  const rules = readLifecycleRules(config) ?? initialLifecycleRules;

  // The same function the save is refused by, over the same catalog, so the
  // sentence a builder reads here is the sentence the server would answer with
  // rather than a second opinion about the rules.
  const check = checkLifecycleRules({ rules, catalog });

  const write = (next: LifecycleRules) => {
    onUpdateConfig({ lifecycleRules: next });
  };

  // Every setter that can change which Events hold a role, or whether a Start
  // Event matches by entity, prunes through `pruneCorrelationPaths`: an override
  // for an Event that just lost its reason to have one should not keep governing
  // runs once its own control has left the screen.
  const setStartEvents = (eventNames: string[]) => {
    write(pruneCorrelationPaths({ ...rules, startEvents: eventNames }));
  };

  const setCancelEvents = (eventNames: string[]) => {
    write(pruneCorrelationPaths({ ...rules, cancelEvents: eventNames }));
  };

  const setConcurrency = (value: Concurrency) => {
    write(pruneCorrelationPaths({ ...rules, concurrency: value }));
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

  return (
    <VStack gap={4}>
      <EventField
        help="A run starts when one of these Events arrives. Naming several is how one workflow answers an appointment being booked and being moved: Concurrency decides what happens to the run already going."
        hasEvents={catalog.events.length > 0}
        inputId={startEventId}
        label="Start Events"
      >
        <EventMultiCombobox
          choices={catalog.events}
          disabled={disabled}
          inputId={startEventId}
          label="Start Events"
          onValueChange={setStartEvents}
          value={rules.startEvents}
        />
        {/* Each request is looked up by the Event and role the control owns
            rather than found in a list: `correlationPathRequestFor` answers
            undefined for a Start Event nothing currently compares, which is what
            leaves an unlimited workflow unasked about a value nothing reads. */}
        {rules.startEvents.map((eventName) => (
          <ChosenEvent
            catalog={catalog}
            disabled={disabled}
            eventName={eventName}
            key={eventName}
            label={findEvent(catalog, eventName)?.label}
            onCommitPath={setCorrelationPath}
            onRemove={() =>
              setStartEvents(
                rules.startEvents.filter((entry) => entry !== eventName)
              )
            }
            request={correlationPathRequestFor({
              rules,
              catalog,
              eventName,
              role: "start",
            })}
          />
        ))}
      </EventField>

      <RadioList
        description="The entity is the value at the Correlation Path. A start carrying no payload uses the workflow itself, so every manual run is about the same entity."
        isDisabled={disabled}
        label="Concurrency"
        onChange={(value) => {
          if (
            value === "unlimited" ||
            value === "newest-wins" ||
            value === "first-wins"
          ) {
            setConcurrency(value);
          }
        }}
        value={rules.concurrency}
      >
        {CONCURRENCY_OPTIONS.map((option) => (
          <RadioListItem
            description={option.description}
            key={option.value}
            label={option.label}
            value={option.value}
          />
        ))}
      </RadioList>

      <VStack gap={1}>
        <CheckboxInput
          description="The Run button and the execute route. With this off, only a Start Event starts a run."
          isDisabled={disabled}
          label="Allow manual runs"
          onChange={(checked) => write({ ...rules, allowManualStart: checked })}
          value={rules.allowManualStart === true}
        />
        {/* The editor derives what downstream nodes may reference from the
              Start Events' payloads, and a manual run carries whatever its caller
              posted. Saying so is what keeps the picker's silence from reading as
              a missing feature. */}
        {rules.startEvents.length === 0 ? (
          <Text color="secondary" type="supporting">
            A manual run's payload is described by nothing, so downstream nodes
            are offered no fields to reference. Add a Start Event to give them
            its payload.
          </Text>
        ) : null}
      </VStack>

      <EventField
        hasEvents={catalog.events.length > 0}
        help="When one of these arrives, Workflow Graph reads its Entity Value at the Correlation Path you set for it and cancels the runs already going for that entity. A canceled run leaves through the Canceled outlet."
        inputId={cancelEventsId}
        label="Cancel Events"
      >
        <EventMultiCombobox
          choices={catalog.events}
          disabled={disabled}
          inputId={cancelEventsId}
          label="Cancel Events"
          onValueChange={setCancelEvents}
          value={rules.cancelEvents}
        />
        {rules.cancelEvents.map((eventName) => (
          <ChosenEvent
            catalog={catalog}
            disabled={disabled}
            eventName={eventName}
            key={eventName}
            label={findEvent(catalog, eventName)?.label}
            onCommitPath={setCorrelationPath}
            onRemove={() =>
              setCancelEvents(
                rules.cancelEvents.filter((entry) => entry !== eventName)
              )
            }
            request={correlationPathRequestFor({
              rules,
              catalog,
              eventName,
              role: "cancel",
            })}
          />
        ))}
      </EventField>

      {check.valid ? null : (
        <Banner
          description={check.error}
          status="warning"
          title="This will not save"
        />
      )}
    </VStack>
  );
}

/**
 * A labelled Event picker, or the sentence that stands in for one where the app
 * declares no Events at all.
 */
function EventField({
  label,
  hasEvents,
  help,
  children,
}: {
  label: string;
  inputId: string;
  hasEvents: boolean;
  help: string;
  children: ReactNode;
}) {
  return (
    <VStack gap={2}>
      <Text type="label">{label}</Text>
      {hasEvents ? (
        children
      ) : (
        <Text color="secondary" type="supporting">
          This server declares no Events. Whoever runs it passes them to
          {" createWfGraphApp"}, and they appear here.
        </Text>
      )}
      <Text color="secondary" type="supporting">
        {help}
      </Text>
    </VStack>
  );
}

/**
 * One chosen Event, with the path its Entity Value is read at.
 *
 * The path is what an arriving payload is compared against, so it is editable
 * here rather than reported here: an Event declaring the wrong field for this
 * workflow would otherwise be a rule the builder can read and cannot fix. An
 * absent `request` is a Start Event nothing currently compares by entity, which
 * has a role to show and no path to ask for.
 */
function ChosenEvent({
  eventName,
  label,
  request,
  catalog,
  onCommitPath,
  onRemove,
  disabled,
}: {
  eventName: string;
  label: string | undefined;
  request: CorrelationPathRequest | undefined;
  catalog: ExtensionCatalog;
  onCommitPath: (eventName: string, path: string) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <Card padding={2}>
      <VStack gap={2}>
        <HStack align="center" justify="between">
          <Text type="supporting">{label ?? eventName}</Text>
          <IconButton
            icon={<Icon icon={X} size="sm" />}
            isDisabled={disabled}
            label={`Remove ${eventName}`}
            onClick={onRemove}
            size="sm"
            variant="ghost"
          />
        </HStack>
        {request ? (
          <CorrelationPathInput
            catalog={catalog}
            disabled={disabled}
            onCommit={onCommitPath}
            request={request}
          />
        ) : null}
      </VStack>
    </Card>
  );
}

/**
 * One Event's Correlation Path for this workflow, chosen out of the paths that
 * Event's payload carries.
 *
 * A path is a value the payload walker reads, so the Event's own field list is
 * the whole of what can be valid, and typing one was how a builder learned
 * otherwise from a run that never matched.
 *
 * The trigger shows the path in force rather than an empty field, so a builder
 * reads what the workflow matches on without knowing whether it came from the
 * declaration or from an override. Choosing the declared path commits no
 * override, which is what keeps a builder who only opened the panel from
 * writing one.
 *
 * The caller renders the Event's own heading; this owns the field and its help
 * line alone, with the Event's name kept as the picker's accessible label.
 */
function CorrelationPathInput({
  request,
  catalog,
  disabled,
  onCommit,
}: {
  request: CorrelationPathRequest;
  catalog: ExtensionCatalog;
  disabled: boolean;
  onCommit: (eventName: string, path: string) => void;
}) {
  const { eventName, declaredPath, suppliedPath } = request;
  const paths = correlationPathChoices(
    catalog,
    eventName,
    declaredPath,
    suppliedPath
  );
  const options = paths.map((path) => ({ value: path, label: path }));
  const commitPath = (next: string | null) =>
    onCommit(eventName, next === declaredPath || next === null ? "" : next);

  return (
    <VStack gap={1}>
      {declaredPath ? (
        <Selector
          isDisabled={disabled}
          isLabelHidden
          label={eventName}
          onChange={commitPath}
          options={options}
          placement="below"
          placeholder="Choose a path"
          value={suppliedPath ?? declaredPath}
          width="100%"
        />
      ) : (
        <Selector
          hasClear
          isDisabled={disabled}
          isLabelHidden
          label={eventName}
          onChange={commitPath}
          options={options}
          placement="below"
          placeholder="Choose a path"
          value={suppliedPath ?? null}
          width="100%"
        />
      )}
      <Text color="secondary" type="supporting">
        {declaredPath
          ? `Runs are matched on this payload path. The Event declares ${declaredPath}; a path here is read instead.`
          : "Runs are matched on this payload path. This Event declares none, so choose the one holding the value that identifies the entity."}
      </Text>
    </VStack>
  );
}

/** The payload paths that can identify an entity, which is what a run matches on. */
const IDENTIFYING_FIELD_TYPES = new Set(["string", "number"]);

/**
 * The payload paths this Event offers, plus any path already in effect.
 *
 * A path the Event does not declare is kept rather than dropped, so a workflow
 * saved against an older payload shape shows what it is matching on instead of
 * appearing to match on something else.
 */
function correlationPathChoices(
  catalog: ExtensionCatalog,
  eventName: string,
  declaredPath: string | undefined,
  suppliedPath: string | undefined
): string[] {
  const offered = (findEvent(catalog, eventName)?.payloadFields ?? [])
    .filter((field) => IDENTIFYING_FIELD_TYPES.has(field.type ?? ""))
    .map((field) => field.path);

  return uniq(compact([...offered, declaredPath, suppliedPath]));
}

/**
 * The three settings, with the consequence each one has.
 *
 * Exported so the test drives itself off these pairs: a fourth setting would
 * otherwise be a control nothing asserts.
 */
export const CONCURRENCY_OPTIONS: ReadonlyArray<{
  value: Concurrency;
  label: string;
  description: string;
}> = [
  {
    value: "unlimited",
    label: "Unlimited",
    description: "Every Event starts its own run.",
  },
  {
    value: "newest-wins",
    label: "Newest wins",
    description:
      "A new run for the same entity supersedes the ones already going, which end with that status.",
  },
  {
    value: "first-wins",
    label: "First wins",
    description:
      "A run already going for the same entity keeps it. The arriving Event is recorded as a Refused Start.",
  },
];
