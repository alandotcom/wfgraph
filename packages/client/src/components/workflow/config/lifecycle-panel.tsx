import { compact, uniq } from "es-toolkit";
import { X } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "#src/components/ui/button";
import { WarningCallout } from "#src/components/ui/callout";
import { Checkbox } from "#src/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#src/components/ui/select";
import { Label } from "#src/components/ui/label";
import { RadioGroup, RadioGroupItem } from "#src/components/ui/radio-group";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  type ExtensionCatalog,
  findEvent,
} from "@wfgraph/shared/extensions/catalog";
import { cn } from "@wfgraph/shared/utils";
import {
  checkLifecycleRules,
  type Concurrency,
  type CorrelationPathRole,
  correlationPathRequestFor,
  type CorrelationPathRequest,
  initialLifecycleRules,
  type LifecycleRules,
  pruneCorrelationPaths,
  readLifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import {
  ConfigSection,
  ConfigViewEmpty,
  ConfigViewRow,
} from "./config-section";
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
 *
 * Three sections, each in view mode until its Edit button is pressed. The
 * refusal below them is outside that, because a configuration a save would
 * reject has to say so without anything being opened first.
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

  // Held here rather than in a store: it is a state of this panel while it is
  // open, belonging to no workflow and worth restoring in none.
  const [editingStart, setEditingStart] = useState(false);
  const [editingConcurrency, setEditingConcurrency] = useState(false);
  const [editingCancel, setEditingCancel] = useState(false);

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
    <div className="space-y-4">
      <ConfigSection
        editable={!disabled}
        stickyHeader
        editing={editingStart}
        help={<p>{START_EVENTS_HELP}</p>}
        label="Start Events"
        onEditingChange={setEditingStart}
        view={
          <ChosenEventSummary
            catalog={catalog}
            empty="No Start Events."
            eventNames={rules.startEvents}
            role="start"
            rules={rules}
          />
        }
      >
        <EventPicker hasEvents={catalog.events.length > 0}>
          <Label className="sr-only" htmlFor={startEventId}>
            Start Events
          </Label>
          <EventMultiCombobox
            choices={catalog.events}
            disabled={disabled}
            inputId={startEventId}
            onValueChange={setStartEvents}
            value={rules.startEvents}
          />
        </EventPicker>
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
      </ConfigSection>

      <ConfigSection
        editable={!disabled}
        stickyHeader
        editing={editingConcurrency}
        help={<ConcurrencyHelp concurrency={rules.concurrency} />}
        label="Concurrency"
        onEditingChange={setEditingConcurrency}
        view={
          <div className="space-y-1">
            <p className="text-sm">{concurrencyLabel(rules.concurrency)}</p>
            <ConfigViewRow label="Allow manual runs">
              {rules.allowManualStart === true ? "Allowed" : "Not allowed"}
            </ConfigViewRow>
            <ManualRunPayloadNotice rules={rules} />
          </div>
        }
      >
        <RadioGroup
          aria-label="Concurrency"
          disabled={disabled}
          onValueChange={setConcurrency}
          value={rules.concurrency}
        >
          {CONCURRENCY_OPTIONS.map((option) => (
            // The consequence of each setting is in the help popover rather
            // than under its radio: three descriptions in the column were the
            // single largest block of prose in the panel.
            <label
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-md border p-2 transition-colors",
                rules.concurrency === option.value
                  ? "border-primary bg-muted/50"
                  : "border-input hover:bg-muted/30",
                disabled && "pointer-events-none opacity-50"
              )}
              key={option.value}
            >
              <RadioGroupItem value={option.value} />
              <span className="font-medium text-sm">{option.label}</span>
            </label>
          ))}
        </RadioGroup>

        <div className="flex items-center gap-2">
          <Checkbox
            checked={rules.allowManualStart === true}
            disabled={disabled}
            id={manualStartId}
            onCheckedChange={(checked) =>
              write({ ...rules, allowManualStart: checked })
            }
          />
          <Label htmlFor={manualStartId}>Allow manual runs</Label>
        </div>

        <ManualRunPayloadNotice rules={rules} />
      </ConfigSection>

      <ConfigSection
        editable={!disabled}
        stickyHeader
        editing={editingCancel}
        help={<p>{CANCEL_EVENTS_HELP}</p>}
        label="Cancel Events"
        onEditingChange={setEditingCancel}
        view={
          <ChosenEventSummary
            catalog={catalog}
            empty="No Cancel Events."
            eventNames={rules.cancelEvents}
            role="cancel"
            rules={rules}
          />
        }
      >
        <EventPicker hasEvents={catalog.events.length > 0}>
          <Label className="sr-only" htmlFor={cancelEventsId}>
            Cancel Events
          </Label>
          <EventMultiCombobox
            choices={catalog.events}
            disabled={disabled}
            inputId={cancelEventsId}
            onValueChange={setCancelEvents}
            value={rules.cancelEvents}
          />
        </EventPicker>
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
      </ConfigSection>

      {check.valid ? null : (
        <WarningCallout title="This will not save">
          {check.error}
        </WarningCallout>
      )}
    </div>
  );
}

/** What the panel says about each role, moved out of the column. */
const START_EVENTS_HELP =
  "A run starts when one of these Events arrives. Naming several is how one workflow answers an appointment being booked and being moved: Concurrency decides what happens to the run already going.";

const CANCEL_EVENTS_HELP =
  "When one of these arrives, Workflow Graph reads its Entity Value at the Correlation Path you set for it and cancels the runs already going for that entity. A canceled run leaves through the Canceled outlet.";

const ENTITY_HELP =
  "The entity is the value at the Correlation Path. A start carrying no payload uses the workflow itself, so every manual run is about the same entity.";

const MANUAL_RUNS_HELP =
  "The Run button and the execute route. With this off, only a Start Event starts a run.";

/**
 * Concurrency's three consequences, the one in force first.
 *
 * A builder opening this has already chosen, so the sentence describing what
 * their workflow does now is the one they are checking.
 */
function ConcurrencyHelp({ concurrency }: { concurrency: Concurrency }) {
  const chosenFirst = [
    ...CONCURRENCY_OPTIONS.filter((option) => option.value === concurrency),
    ...CONCURRENCY_OPTIONS.filter((option) => option.value !== concurrency),
  ];

  return (
    <>
      {chosenFirst.map((option) => (
        <p key={option.value}>
          <span className="font-medium text-foreground">{option.label}</span>{" "}
          {option.description}
        </p>
      ))}
      <p>{ENTITY_HELP}</p>
      <p>
        <span className="font-medium text-foreground">Allow manual runs</span>{" "}
        {MANUAL_RUNS_HELP}
      </p>
    </>
  );
}

/**
 * The Events holding one role, read as text.
 *
 * The path a run is matched on is part of the sentence rather than a second
 * line, because it is the half of the rule a builder cannot infer from the
 * Event's name. An Event owing a path and carrying none says nothing here: the
 * refusal below the sections is what names it.
 */
function ChosenEventSummary({
  eventNames,
  role,
  rules,
  catalog,
  empty,
}: {
  eventNames: readonly string[];
  role: CorrelationPathRole;
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
  empty: string;
}) {
  if (eventNames.length === 0) {
    return <ConfigViewEmpty>{empty}</ConfigViewEmpty>;
  }

  return (
    <ul className="space-y-1">
      {eventNames.map((eventName) => {
        const request = correlationPathRequestFor({
          rules,
          catalog,
          eventName,
          role,
        });
        const path = request?.suppliedPath ?? request?.declaredPath;

        return (
          <li className="text-sm" key={eventName}>
            <span title={eventName}>
              {findEvent(catalog, eventName)?.label ?? eventName}
            </span>
            {path ? (
              <span className="text-muted-foreground text-xs">
                {" correlated on "}
                <span className="font-mono">{path}</span>
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * What the editor can offer a downstream node comes off the Start Events'
 * payloads, and a manual run carries whatever its caller posted. Saying so is
 * what keeps the picker's silence from reading as a missing feature.
 *
 * A consequence of the configuration rather than an explanation of the control,
 * so it stays in the column in both modes instead of moving into the popover.
 */
function ManualRunPayloadNotice({ rules }: { rules: LifecycleRules }) {
  if (rules.startEvents.length > 0) {
    return null;
  }

  return (
    <p className="text-muted-foreground text-xs">
      A manual run's payload is described by nothing, so downstream nodes are
      offered no fields to reference. Add a Start Event to give them its
      payload.
    </p>
  );
}

/**
 * The Event picker, or the sentence that stands in for one where the app
 * declares no Events at all.
 */
function EventPicker({
  hasEvents,
  children,
}: {
  hasEvents: boolean;
  children: ReactNode;
}) {
  if (hasEvents) {
    return children;
  }

  return (
    <p className="text-muted-foreground text-xs">
      This server declares no Events. Whoever runs it passes them to
      <code className="mx-1 font-mono text-xs">createWfGraphApp</code>, and they
      appear here.
    </p>
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
    <div className="space-y-2 rounded-md border p-2">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-xs" title={eventName}>
          {label ?? eventName}
        </p>
        <Button
          aria-label={`Remove ${eventName}`}
          className="size-7 shrink-0"
          disabled={disabled}
          onClick={onRemove}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {request ? (
        <CorrelationPathInput
          catalog={catalog}
          disabled={disabled}
          onCommit={onCommitPath}
          request={request}
        />
      ) : null}
    </div>
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
  const inputId = useId();
  const { eventName, declaredPath, suppliedPath } = request;
  const paths = correlationPathChoices(
    catalog,
    eventName,
    declaredPath,
    suppliedPath
  );

  return (
    <div className="space-y-1">
      <Label className="sr-only" htmlFor={inputId}>
        {eventName}
      </Label>
      <Select
        disabled={disabled}
        // Choosing the path the Event already declares is the same as declaring
        // no override, so it commits the empty string and the declaration stands.
        onValueChange={(next) =>
          onCommit(
            eventName,
            next === declaredPath || next === null ? "" : next
          )
        }
        value={suppliedPath ?? declaredPath ?? null}
      >
        <SelectTrigger className="w-full" id={inputId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {declaredPath ? null : (
            // An Event declaring no path has none to choose back to, so this is
            // the only way to undo a choice and leave the workflow saying so.
            <SelectItem value={null}>Choose a path</SelectItem>
          )}
          {paths.map((path) => (
            <SelectItem key={path} value={path}>
              {path}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-muted-foreground text-xs">
        {declaredPath
          ? `Runs are matched on this payload path. The Event declares ${declaredPath}; a path here is read instead.`
          : "Runs are matched on this payload path. This Event declares none, so choose the one holding the value that identifies the entity."}
      </p>
    </div>
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

/** The setting in force, as the radio group words it. */
function concurrencyLabel(concurrency: Concurrency): string {
  return (
    CONCURRENCY_OPTIONS.find((option) => option.value === concurrency)?.label ??
    concurrency
  );
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
