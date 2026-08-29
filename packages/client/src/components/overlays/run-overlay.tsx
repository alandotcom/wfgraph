import { Send } from "lucide-react";
import { useState } from "react";
import { Button } from "#src/components/ui/button";
import { Checkbox } from "#src/components/ui/checkbox";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#src/components/ui/select";
import { whenChosen } from "#src/lib/select-choice";
import {
  formValuesFromPayload,
  parseTestPayload,
  payloadFromFormValues,
  type TestPayloadField,
  type TestPayloadFormValues,
  testPayloadFields,
} from "#src/lib/test-payload";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  type RunSends,
  runOverlayCopy,
  runSendsLabel,
  type WorkflowRunTarget,
} from "#src/lib/workflow-run-labels";
import {
  findEvent,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import {
  type TestPayloads,
  testPayloadFor,
} from "@wfgraph/shared/lifecycle/test-payloads";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";
import type { OverlayComponentProps } from "./types";

/**
 * The value the Event select carries for a run that stands in for no Event. An
 * Event name is never empty, so no real choice collides with it.
 */
const NO_EVENT = "";

export type RunRequest = {
  eventName?: string;
  input: JsonObject;
};

type RunOverlayProps = OverlayComponentProps<{
  /**
   * Which graph this run starts, and what it is called. The overlay's heading,
   * its opening sentence and its confirm button are all read off this one
   * value, so the verb the operator pressed is the verb they confirm.
   */
  target: WorkflowRunTarget;
  /** The workflow's Start Events, in the order the Lifecycle panel lists them. */
  startEvents: readonly string[];
  /** Whether a run naming no Event is one this workflow takes at all. */
  allowManualStart: boolean;
  /**
   * Whether the graph splits on the Event a run is on. Such a graph refuses an
   * Event-less run, so the overlay says so before the request rather than after.
   */
  hasEventSplit: boolean;
  /** The samples the workflow kept, one per Event plus the Event-less one. */
  savedPayloads: TestPayloads;
  /**
   * What the graph this run executes can send outward. Only a live published
   * run states it, and it is counted off that version's own nodes.
   */
  sends: RunSends;
  onRun: (request: RunRequest) => void;
}>;

/** What the Event select shows for one Start Event: its label, then its name. */
function eventLabel(catalog: ExtensionCatalog, eventName: string): string {
  return findEvent(catalog, eventName)?.label ?? eventName;
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: TestPayloadField;
  value: string;
  onChange: (next: string) => void;
}) {
  if (field.control === "checkbox") {
    return (
      <Checkbox
        checked={value === "true"}
        id={field.path}
        onCheckedChange={(checked) => onChange(checked ? "true" : "false")}
      />
    );
  }

  if (field.control === "select") {
    const items = (field.options ?? []).map((option) => ({
      label: option,
      value: option,
    }));
    return (
      <Select items={items} onValueChange={whenChosen(onChange)} value={value}>
        <SelectTrigger className="w-full" id={field.path}>
          <SelectValue placeholder="Choose a value" />
        </SelectTrigger>
        <SelectContent>
          {(field.options ?? []).map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <Input
      id={field.path}
      onChange={(event) => onChange(event.target.value)}
      type={
        field.control === "number"
          ? "number"
          : field.control === "datetime"
            ? "datetime-local"
            : "text"
      }
      value={value}
    />
  );
}

function PayloadForm({
  fields,
  values,
  onChange,
  hasEvent,
}: {
  fields: readonly TestPayloadField[];
  values: TestPayloadFormValues;
  onChange: (path: string, next: string) => void;
  /** Whether the run stands in for an Event, which is what declares the fields. */
  hasEvent: boolean;
}) {
  if (fields.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {hasEvent
          ? "This Event declares no payload field the form can draw."
          : "A run that stands in for no Event has no declared field to draw."}{" "}
        Use the JSON tab to write the payload.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {fields.map((field) => (
        <div className="space-y-2" key={field.path}>
          <Label className="font-mono text-xs" htmlFor={field.path}>
            {field.path}
            {field.optional && (
              <span className="ml-2 font-sans text-muted-foreground">
                optional
              </span>
            )}
          </Label>
          <FieldControl
            field={field}
            onChange={(next) => onChange(field.path, next)}
            value={values[field.path] ?? ""}
          />
          {field.description && (
            <p className="text-muted-foreground text-xs">{field.description}</p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The data a run carries, gathered before it starts.
 *
 * Two things leave here: the payload, which every template downstream addresses,
 * and the Event the run stands in for, which is what an Event Split routes on. A
 * run given neither reaches the first node that needs one and stops there, so
 * this is the screen that keeps a run from being a different thing than the run
 * it is standing in for.
 *
 * One component serves both verbs. The Event and payload halves are identical
 * for each; `target` is what changes the words around them.
 */
export function RunOverlay({
  overlayId,
  target,
  startEvents,
  allowManualStart,
  hasEventSplit,
  savedPayloads,
  sends,
  onRun,
}: RunOverlayProps) {
  const catalog = useExtensionCatalog();
  const { closeAll } = useOverlay();
  const copy = runOverlayCopy(target);
  // The one run that leaves the building, which is what the confirm button's
  // destructive variant acts on.
  const reachesRealRecipients =
    target.graph === "published" && target.workflowMode === "live";
  // The band states the sends the published graph holds. A version built only
  // from waits, conditions and internal steps makes none, and an alarm over a
  // sentence saying so spends the signal reserved for real sends.
  const showSendsBand = reachesRealRecipients && sends.count > 0;

  // The first Start Event, since one of them is the ordinary shape. A workflow
  // with none can only be the Event-less manual start.
  const [selectedEvent, setSelectedEvent] = useState<string>(
    startEvents[0] ?? NO_EVENT
  );
  const [pane, setPane] = useState<"form" | "json">("form");

  const eventName = selectedEvent === NO_EVENT ? undefined : selectedEvent;
  const savedPayload = testPayloadFor(savedPayloads, eventName);

  const fields = testPayloadFields(
    eventName ? findEvent(catalog, eventName) : undefined
  );

  const [values, setValues] = useState<TestPayloadFormValues>(() =>
    formValuesFromPayload(fields, savedPayload)
  );
  const [jsonText, setJsonText] = useState(() =>
    JSON.stringify(savedPayload ?? {}, null, 2)
  );
  const [jsonError, setJsonError] = useState<string | null>(null);

  // The payload the JSON pane holds, which is also what the form writes into: a
  // path the form has no field for survives the round trip that way.
  const [basePayload, setBasePayload] = useState<JsonObject>(
    () => savedPayload ?? {}
  );

  const chooseEvent = (next: string) => {
    setSelectedEvent(next);
    const chosen = next === NO_EVENT ? undefined : next;
    const payload = testPayloadFor(savedPayloads, chosen) ?? {};
    const nextFields = testPayloadFields(
      chosen ? findEvent(catalog, chosen) : undefined
    );

    setValues(formValuesFromPayload(nextFields, payload));
    setJsonText(JSON.stringify(payload, null, 2));
    setBasePayload(payload);
    setJsonError(null);
  };

  /** The form's values as a payload, on top of whatever the JSON pane holds. */
  const currentPayload = () =>
    payloadFromFormValues(fields, values, basePayload);

  const showJson = () => {
    setJsonText(JSON.stringify(currentPayload(), null, 2));
    setJsonError(null);
    setPane("json");
  };

  const showForm = () => {
    const parsed = parseTestPayload(jsonText);
    if (!parsed.ok) {
      setJsonError(parsed.error);
      return;
    }

    setValues(formValuesFromPayload(fields, parsed.payload));
    setBasePayload(parsed.payload);
    setJsonError(null);
    setPane("form");
  };

  const eventIsRequired = hasEventSplit;
  const canRun = !eventIsRequired || eventName !== undefined;

  const handleRun = () => {
    if (pane === "json") {
      const parsed = parseTestPayload(jsonText);
      if (!parsed.ok) {
        setJsonError(parsed.error);
        return;
      }

      onRun({ ...(eventName ? { eventName } : {}), input: parsed.payload });
      closeAll();
      return;
    }

    onRun({ ...(eventName ? { eventName } : {}), input: currentPayload() });
    closeAll();
  };

  // A manual-only workflow has one way to start and no Event to stand in for,
  // so the select would offer a single choice nobody can change. An Event
  // Split keeps the block, since its sentence is what says why Run is off.
  const showEventSelect =
    startEvents.length > 0 || !allowManualStart || hasEventSplit;

  const eventItems = [
    ...startEvents.map((name) => ({
      label: eventLabel(catalog, name),
      value: name,
    })),
    ...(allowManualStart
      ? [{ label: "No Event (manual start)", value: NO_EVENT }]
      : []),
  ];

  return (
    <Overlay
      actions={[
        { label: "Cancel", variant: "outline", onClick: closeAll },
        {
          label: copy.confirmLabel,
          onClick: handleRun,
          disabled: !canRun,
          ...(reachesRealRecipients ? { variant: "destructive" as const } : {}),
        },
      ]}
      description={copy.description}
      overlayId={overlayId}
      title={copy.title}
    >
      <div className="space-y-6">
        {/* Bordered rather than filled: the confirm button carries the
            dialog's one destructive fill, and a band wearing the same fill
            reads as a second banner beside it. */}
        {showSendsBand && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-foreground text-sm">
            <Send aria-hidden className="size-3.5 shrink-0 text-destructive" />
            <p>{runSendsLabel(sends)}</p>
          </div>
        )}

        {showEventSelect ? (
          <div className="space-y-2">
            <Label htmlFor="runEvent">
              Which Event does this run stand in for?
            </Label>
            <Select
              items={eventItems}
              onValueChange={whenChosen(chooseEvent)}
              value={selectedEvent}
            >
              <SelectTrigger className="w-full" id="runEvent">
                <SelectValue placeholder="Choose an Event" />
              </SelectTrigger>
              <SelectContent>
                {startEvents.map((name) => (
                  <SelectItem key={name} value={name}>
                    {eventLabel(catalog, name)}
                  </SelectItem>
                ))}
                {allowManualStart && (
                  <SelectItem disabled={hasEventSplit} value={NO_EVENT}>
                    No Event (manual start)
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            {eventIsRequired && (
              <p className="text-muted-foreground text-xs">
                This workflow splits on the Event a run is on, so a run has to
                name one.
              </p>
            )}
          </div>
        ) : (
          // With no select to sit under, the same fact is what a disabled
          // confirm button is waiting for, so it stands on its own rather than
          // leaving the reader a greyed-out button and no sentence.
          eventIsRequired && (
            <p className="text-muted-foreground text-sm">
              This workflow splits on the Event a run is on, and the Lifecycle
              node declares no Start Event for a run to name.
            </p>
          )
        )}

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">Payload</span>
            <div className="flex gap-1">
              <Button
                onClick={showForm}
                size="sm"
                variant={pane === "form" ? "secondary" : "ghost"}
              >
                Form
              </Button>
              <Button
                onClick={showJson}
                size="sm"
                variant={pane === "json" ? "secondary" : "ghost"}
              >
                JSON
              </Button>
            </div>
          </div>

          {pane === "form" ? (
            <PayloadForm
              fields={fields}
              hasEvent={eventName !== undefined}
              onChange={(path, next) =>
                setValues((current) => ({ ...current, [path]: next }))
              }
              values={values}
            />
          ) : (
            <textarea
              aria-label="Payload JSON"
              className="min-h-64 w-full rounded-md border border-input bg-transparent p-3 font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onChange={(event) => {
                setJsonText(event.target.value);
                setJsonError(null);
              }}
              spellCheck={false}
              value={jsonText}
            />
          )}

          {jsonError && <p className="text-destructive text-xs">{jsonError}</p>}
        </div>
      </div>
    </Overlay>
  );
}
