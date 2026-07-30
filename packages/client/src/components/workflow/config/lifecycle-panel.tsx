import { CalendarClock, Copy, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "#src/components/ui/button";
import { Checkbox } from "#src/components/ui/checkbox";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import { getBasePath } from "#src/lib/base-path";
import { getExtensionCatalog } from "#src/lib/extensions";
import { buildEventIntakeUrl } from "@rova/shared/workflow/event-intake-url";
import { cn } from "@rova/shared/utils";
import {
  checkLifecycleRules,
  type Concurrency,
  type CorrelationPathRole,
  eventsNeedingCorrelationPath,
  initialLifecycleRules,
  type LifecycleRules,
  readLifecycleRules,
  SCHEDULE_INTERIM_MESSAGE,
} from "@rova/shared/workflow/lifecycle-rules";
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
 * The schedule is present as a placeholder, with no control: a builder can see
 * where it will go, and the sentence beside it is the one a save would answer
 * with. Nothing can write one yet.
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
  const startEventsLabelId = useId();
  const cancelEventsLabelId = useId();
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

  const toggleStartEvent = (eventName: string) => {
    write({
      ...rules,
      startEvents: rules.startEvents.includes(eventName)
        ? rules.startEvents.filter((entry) => entry !== eventName)
        : [...rules.startEvents, eventName],
    });
  };

  const toggleCancelEvent = (eventName: string) => {
    write({
      ...rules,
      cancelEvents: rules.cancelEvents.includes(eventName)
        ? rules.cancelEvents.filter((entry) => entry !== eventName)
        : [...rules.cancelEvents, eventName],
    });
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
      <EventPicker
        disabled={disabled}
        events={catalog.events}
        help="Each of these starts a run when it arrives. An Event that starts nothing here can still resume a run parked on it."
        label="Start Events"
        labelId={startEventsLabelId}
        onToggle={toggleStartEvent}
        selected={rules.startEvents}
      />

      {rules.startEvents.length > 0 ? (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <p className="font-medium text-sm">Where to send these Events</p>
          <p className="text-muted-foreground text-xs">
            One URL per Event, app-wide: an Event is global, so every workflow
            that starts on it sees what arrives. Send a POST carrying an API
            key.
          </p>
          {rules.startEvents.map((eventName) => (
            <EventUrlRow eventName={eventName} key={eventName} />
          ))}
        </div>
      ) : null}

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
              // The stored value is in the key, so a rules object rewritten
              // elsewhere re-seeds the draft rather than leaving a stale one.
              key={`${request.eventName}:${request.suppliedPath ?? ""}`}
              onCommit={setCorrelationPath}
              role={request.role}
              storedPath={request.suppliedPath}
            />
          ))}
        </div>
      ) : null}

      <div className="space-y-2">
        <Label>Concurrency</Label>
        <div className="space-y-1.5">
          {CONCURRENCY_OPTIONS.map((option) => (
            <button
              aria-pressed={rules.concurrency === option.value}
              className={cn(
                "w-full rounded-md border p-2 text-left transition-colors",
                "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                rules.concurrency === option.value
                  ? "border-primary bg-muted/50"
                  : "border-input hover:bg-muted/30",
                disabled && "pointer-events-none opacity-50"
              )}
              disabled={disabled}
              key={option.value}
              onClick={() => write({ ...rules, concurrency: option.value })}
              type="button"
            >
              <p className="font-medium text-sm">{option.label}</p>
              <p className="text-muted-foreground text-xs">
                {option.description}
              </p>
            </button>
          ))}
        </div>
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
              Start Events' payloads, and a manual run carries whatever its caller
              posted. Saying so is what keeps the picker's silence from reading as
              a missing feature. */}
          {rules.startEvents.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              A manual run's payload is described by nothing, so downstream
              nodes are offered no fields to reference. Add a Start Event to
              give them its payload.
            </p>
          ) : null}
        </div>
      </div>

      <EventPicker
        disabled={disabled}
        events={catalog.events}
        help="Each of these routes runs already going to the Canceled outlet."
        label="Cancel Events"
        labelId={cancelEventsLabelId}
        onToggle={toggleCancelEvent}
        selected={rules.cancelEvents}
      />

      <div className="space-y-2 rounded-md border border-dashed p-3 opacity-70">
        <div className="flex items-center gap-2">
          <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" />
          <p className="font-medium text-sm">Schedule</p>
        </div>
        <p className="text-muted-foreground text-xs">
          {SCHEDULE_INTERIM_MESSAGE}
        </p>
      </div>

      {check.valid ? null : (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          <div className="space-y-0.5">
            <p className="font-medium text-amber-700 text-xs dark:text-amber-200">
              This will not save
            </p>
            <p className="text-amber-700 text-xs dark:text-amber-200">
              {check.error}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A row of toggle buttons over the catalog's Events, shared by the Start and
 * Cancel pickers: only the selection, the toggle, and the two labels differ
 * between them.
 */
function EventPicker({
  label,
  labelId,
  events,
  selected,
  onToggle,
  disabled,
  help,
}: {
  label: string;
  labelId: string;
  events: ReadonlyArray<{ name: string; label: string }>;
  selected: readonly string[];
  onToggle: (eventName: string) => void;
  disabled: boolean;
  help: string;
}) {
  return (
    <div className="space-y-2">
      <Label id={labelId}>{label}</Label>
      {events.length > 0 ? (
        <div
          aria-labelledby={labelId}
          className="flex flex-wrap gap-1.5"
          role="group"
        >
          {events.map((event) => {
            const isSelected = selected.includes(event.name);
            return (
              <button
                aria-pressed={isSelected}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition-colors",
                  "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input text-muted-foreground hover:bg-muted/50",
                  disabled && "pointer-events-none opacity-50"
                )}
                disabled={disabled}
                key={event.name}
                onClick={() => onToggle(event.name)}
                title={event.name}
                type="button"
              >
                {event.label}
              </button>
            );
          })}
        </div>
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

/** What each role calls the node that is asking for a path. */
const ROLE_LABELS: Record<CorrelationPathRole, string> = {
  start: "starts a run",
  cancel: "cancels runs",
};

/**
 * One Event's Correlation Path, as a controlled draft committed on blur.
 *
 * Controlled rather than defaulted, because the stored value can change under the
 * input: another edit rewrites the rules object, and an uncontrolled input would
 * keep showing whatever was typed into the last one React reused. The commit
 * trims, so a path is stored the way the payload walker will read it.
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
  const [draft, setDraft] = useState(storedPath ?? "");
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
        onBlur={() => onCommit(eventName, draft)}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="appointment.id"
        value={draft}
      />
    </div>
  );
}

/**
 * One Event's intake URL, with the copy button a sender needs.
 *
 * The URL is the mount point plus the Event's name, and it carries the base path
 * because a Rova mounted at `/workflows` answers there and nowhere else. There is
 * no per-workflow URL to copy any more: an Event posted for one workflow reaches
 * every workflow subscribing to it, which is the whole model.
 */
function EventUrlRow({ eventName }: { eventName: string }) {
  const url = buildEventIntakeUrl({
    origin: typeof window === "undefined" ? "" : window.location.origin,
    basePath: getBasePath(),
    eventName,
  });

  return (
    <div className="flex items-center gap-2">
      <code
        className="min-w-0 flex-1 truncate rounded-sm border bg-background px-2 py-1 font-mono text-xs"
        title={url}
      >
        POST {url}
      </code>
      <Button
        aria-label={`Copy the URL for ${eventName}`}
        className="size-7 shrink-0"
        onClick={() => {
          void navigator.clipboard.writeText(url);
          toast.success(`URL for ${eventName} copied`);
        }}
        size="icon"
        type="button"
        variant="ghost"
      >
        <Copy className="size-3.5" />
      </Button>
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
      "A run already going for the same entity keeps it. The arriving Event is recorded as a Refused Start, and still resumes anything waiting.",
  },
];
