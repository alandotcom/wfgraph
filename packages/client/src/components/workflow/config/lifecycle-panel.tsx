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
  type CorrelationPathRole,
  eventsNeedingCorrelationPath,
  initialLifecycleRules,
  type LifecycleRules,
  readLifecycleRules,
  resolveCorrelationPath,
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

  const setStartEvent = (eventName: string | undefined) => {
    write({ ...rules, startEvent: eventName });
  };

  const setCancelEvents = (eventNames: string[]) => {
    write({ ...rules, cancelEvents: eventNames });
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

  // The same set the save is refused over, so an unlimited workflow is not asked
  // about a value nothing compares.
  const pathRequests = eventsNeedingCorrelationPath({ rules, catalog });

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

      {pathRequests.length > 0 ? (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          <p className="text-muted-foreground text-xs">
            These Events declare no Correlation Path. Enter the payload path
            holding the value that identifies the entity, or ask whoever defined
            the Event to declare it.
          </p>
          {pathRequests.map((request) => (
            <CorrelationPathInput
              disabled={disabled}
              eventName={request.eventName}
              key={request.eventName}
              onCommit={setCorrelationPath}
              role={request.role}
              storedPath={request.suppliedPath}
            />
          ))}
        </div>
      ) : null}

      <div className="space-y-2">
        <Label id={concurrencyLabelId}>Concurrency</Label>
        <RadioGroup
          aria-labelledby={concurrencyLabelId}
          disabled={disabled}
          onValueChange={(value: Concurrency) =>
            write({ ...rules, concurrency: value })
          }
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
          The entity is the value at the Event's Correlation Path. A start
          carrying no payload uses the workflow itself, so every manual run is
          about the same entity.
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
        help="When one of these arrives, Rova reads its Entity Value at the Event's Correlation Path and cancels the runs already going for that entity. A canceled run leaves through the Canceled outlet."
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
            onRemove={() =>
              setCancelEvents(
                rules.cancelEvents.filter((entry) => entry !== eventName)
              )
            }
            path={resolveCorrelationPath({
              rules,
              eventName,
              declaredPath: findEvent(catalog, eventName)?.correlationPath,
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
 * One chosen Cancel Event, with the path its Entity Value will be read at.
 *
 * The path is what an arriving payload is compared against, so a builder who
 * cannot see it cannot tell a rule that will claim runs from one that will claim
 * none.
 */
function ChosenCancelEvent({
  eventName,
  label,
  path,
  onRemove,
  disabled,
}: {
  eventName: string;
  label: string | undefined;
  path: string | undefined;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border p-2">
      <div className="min-w-0" title={eventName}>
        {label ? <p className="truncate text-xs">{label}</p> : null}
        <p className="truncate font-mono text-[10px] text-muted-foreground">
          {eventName}
        </p>
        <p className="truncate text-[10px] text-muted-foreground">
          Correlation Path: {path ?? "none yet"}
        </p>
      </div>
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
  );
}

/** What each role calls the node that is asking for a path. */
const ROLE_LABELS: Record<CorrelationPathRole, string> = {
  start: "starts a run",
  cancel: "cancels runs",
};

/**
 * One Event's Correlation Path, written through on every keystroke.
 *
 * Write-through rather than commit-on-blur, because Cmd+S is a capture-phase
 * listener that a focused field never sees: a blur-committed draft was saved as
 * whatever the field held before it was typed in, and the refusal that came back
 * named a path the builder could read on the screen. The autosave is debounced,
 * so a keystroke costs no request of its own. The write trims, so a path is
 * stored the way the payload walker will read it.
 */
function CorrelationPathInput({
  eventName,
  role,
  storedPath,
  disabled,
  onCommit,
}: {
  eventName: string;
  role: CorrelationPathRole;
  storedPath: string | undefined;
  disabled: boolean;
  onCommit: (eventName: string, path: string) => void;
}) {
  const inputId = useId();

  return (
    <div className="space-y-1">
      <Label className="font-mono text-xs" htmlFor={inputId}>
        {eventName}
      </Label>
      <p className="text-muted-foreground text-xs">{ROLE_LABELS[role]}</p>
      <Input
        disabled={disabled}
        id={inputId}
        onChange={(event) => onCommit(eventName, event.target.value)}
        placeholder="appointment.id"
        value={storedPath ?? ""}
      />
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
