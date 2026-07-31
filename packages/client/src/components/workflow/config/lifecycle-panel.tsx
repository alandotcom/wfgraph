import { X } from "lucide-react";
import { type ReactNode, useId } from "react";
import { Button } from "#src/components/ui/button";
import { WarningCallout } from "#src/components/ui/callout";
import { Checkbox } from "#src/components/ui/checkbox";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import { Radio, RadioGroup } from "#src/components/ui/radio-group";
import { getExtensionCatalog } from "#src/lib/extensions";
import { findEvent } from "@rova/shared/extensions/catalog";
import { cn } from "@rova/shared/utils";
import {
  checkLifecycleRules,
  type Concurrency,
  correlationPathRequestFor,
  type CorrelationPathRequest,
  initialLifecycleRules,
  type LifecycleRules,
  pruneCorrelationPaths,
  readLifecycleRules,
} from "@rova/shared/workflow/lifecycle-rules";
import { EventCombobox, EventMultiCombobox } from "./event-combobox";
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
  const startEventId = useId();
  const cancelEventsId = useId();
  const concurrencyLabelId = useId();
  const manualStartId = useId();
  const catalog = getExtensionCatalog();
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
  const setStartEvent = (eventName: string | undefined) => {
    write(pruneCorrelationPaths({ ...rules, startEvent: eventName }));
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

  // Each request is looked up directly, by the Event and role the control beside
  // it owns, rather than found in a list: `correlationPathRequestFor` answers
  // undefined for a Start Event nothing currently compares, which is what leaves
  // an unlimited workflow unasked about a value nothing reads.
  const startPathRequest = rules.startEvent
    ? correlationPathRequestFor({
        rules,
        catalog,
        eventName: rules.startEvent,
        role: "start",
      })
    : undefined;

  return (
    <div className="space-y-4">
      <EventField
        help="A run starts when this Event arrives."
        hasEvents={catalog.events.length > 0}
        inputId={startEventId}
        label="Start Event"
      >
        <EventCombobox
          choices={catalog.events}
          disabled={disabled}
          inputId={startEventId}
          onValueChange={setStartEvent}
          value={rules.startEvent}
        />
      </EventField>

      {startPathRequest ? (
        <div className="rounded-md border bg-muted/30 p-3">
          <p
            className="mb-1 truncate font-mono text-xs"
            title={startPathRequest.eventName}
          >
            {startPathRequest.eventName}
          </p>
          <CorrelationPathInput
            disabled={disabled}
            onCommit={setCorrelationPath}
            request={startPathRequest}
          />
        </div>
      ) : null}

      <div className="space-y-2">
        <Label id={concurrencyLabelId}>Concurrency</Label>
        <RadioGroup
          aria-labelledby={concurrencyLabelId}
          disabled={disabled}
          onValueChange={setConcurrency}
          value={rules.concurrency}
        >
          {CONCURRENCY_OPTIONS.map((option) => (
            <label
              className={cn(
                "flex w-full cursor-pointer items-start gap-2 rounded-md border p-2 transition-colors",
                rules.concurrency === option.value
                  ? "border-primary bg-muted/50"
                  : "border-input hover:bg-muted/30",
                disabled && "pointer-events-none opacity-50"
              )}
              key={option.value}
            >
              <Radio className="mt-0.5" value={option.value} />
              <div>
                <p className="font-medium text-sm">{option.label}</p>
                <p className="text-muted-foreground text-xs">
                  {option.description}
                </p>
              </div>
            </label>
          ))}
        </RadioGroup>
        <p className="text-muted-foreground text-xs">
          The entity is the value at the Correlation Path. A start carrying no
          payload uses the workflow itself, so every manual run is about the
          same entity.
        </p>
      </div>

      <div className="flex items-start gap-2">
        <Checkbox
          checked={rules.allowManualStart === true}
          disabled={disabled}
          id={manualStartId}
          onCheckedChange={(checked) =>
            write({ ...rules, allowManualStart: checked })
          }
        />
        <div className="space-y-0.5">
          <Label htmlFor={manualStartId}>Allow manual runs</Label>
          <p className="text-muted-foreground text-xs">
            The Run button and the execute route. With this off, only a Start
            Event starts a run.
          </p>
          {/* The editor derives what downstream nodes may reference from the
              Start Event's payload, and a manual run carries whatever its caller
              posted. Saying so is what keeps the picker's silence from reading as
              a missing feature. */}
          {rules.startEvent === undefined ? (
            <p className="text-muted-foreground text-xs">
              A manual run's payload is described by nothing, so downstream
              nodes are offered no fields to reference. Add a Start Event to
              give them its payload.
            </p>
          ) : null}
        </div>
      </div>

      <EventField
        hasEvents={catalog.events.length > 0}
        help="When one of these arrives, Rova reads its Entity Value at the Correlation Path you set for it and cancels the runs already going for that entity. A canceled run leaves through the Canceled outlet."
        inputId={cancelEventsId}
        label="Cancel Events"
      >
        <EventMultiCombobox
          choices={catalog.events}
          disabled={disabled}
          inputId={cancelEventsId}
          onValueChange={setCancelEvents}
          value={rules.cancelEvents}
        />
        {rules.cancelEvents.map((eventName) => (
          <ChosenCancelEvent
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
        <WarningCallout title="This will not save">
          {check.error}
        </WarningCallout>
      )}
    </div>
  );
}

/**
 * A labelled Event picker, or the sentence that stands in for one where the app
 * declares no Events at all.
 */
function EventField({
  label,
  inputId,
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
    <div className="space-y-2">
      <Label htmlFor={inputId}>{label}</Label>
      {hasEvents ? (
        children
      ) : (
        <p className="text-muted-foreground text-xs">
          This server declares no Events. Whoever runs it passes them to
          <code className="mx-1 font-mono text-xs">createRovaApp</code>, and
          they appear here.
        </p>
      )}
      <p className="text-muted-foreground text-xs">{help}</p>
    </div>
  );
}

/**
 * One chosen Cancel Event, with the path its Entity Value is read at.
 *
 * The path is what an arriving payload is compared against, so it is editable
 * here rather than reported here: an Event declaring the wrong field for this
 * workflow would otherwise be a rule the builder can read and cannot fix. A
 * cancel role always matches by entity, so `request` is never absent.
 */
function ChosenCancelEvent({
  eventName,
  label,
  request,
  onCommitPath,
  onRemove,
  disabled,
}: {
  eventName: string;
  label: string | undefined;
  request: CorrelationPathRequest;
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
      <CorrelationPathInput
        disabled={disabled}
        onCommit={onCommitPath}
        request={request}
      />
    </div>
  );
}

/**
 * One Event's Correlation Path field for this workflow, written through on
 * every keystroke.
 *
 * Write-through rather than commit-on-blur, because Cmd+S is a capture-phase
 * listener that a focused field never sees: a blur-committed draft was saved as
 * whatever the field held before it was typed in, and the refusal that came back
 * named a path the builder could read on the screen. The autosave is debounced,
 * so a keystroke costs no request of its own. The write trims, so a path is
 * stored the way the payload walker will read it.
 *
 * The Event Author's declaration is the placeholder rather than the value: an
 * empty field means the declaration stands, and seeding it would write an
 * override on mount for a builder who only opened the panel.
 *
 * The caller renders the Event's own heading; this owns the field and its help
 * line alone, with the Event's name kept as the input's accessible label.
 */
function CorrelationPathInput({
  request,
  disabled,
  onCommit,
}: {
  request: CorrelationPathRequest;
  disabled: boolean;
  onCommit: (eventName: string, path: string) => void;
}) {
  const inputId = useId();
  const { eventName, declaredPath, suppliedPath } = request;

  return (
    <div className="space-y-1">
      <Label className="sr-only" htmlFor={inputId}>
        {eventName}
      </Label>
      <Input
        disabled={disabled}
        id={inputId}
        onChange={(event) => onCommit(eventName, event.target.value)}
        placeholder={declaredPath ?? "appointment.id"}
        value={suppliedPath ?? ""}
      />
      <p className="text-muted-foreground text-xs">
        {declaredPath
          ? `Runs are matched on this payload path. The Event declares ${declaredPath}; a path here is read instead.`
          : "Runs are matched on this payload path. This Event declares none, so enter the one holding the value that identifies the entity."}
      </p>
    </div>
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
