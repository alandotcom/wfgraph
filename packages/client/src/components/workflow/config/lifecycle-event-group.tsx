import { compact, uniq } from "es-toolkit";
import { X } from "lucide-react";
import { type ReactNode, useId } from "react";
import { toast } from "sonner";
import { Button } from "#src/components/ui/button";
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
  findEvent,
} from "@wfgraph/shared/extensions/catalog";
import { catalogEventChoices } from "./event-choices";
import {
  type CorrelationPathRequest,
  correlationPathRequestFor,
  type LifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { ConfigGroup } from "./config-section";
import { EventMultiCombobox } from "./event-combobox";

type EventRole = "start" | "cancel";

const ROLE_COPY = {
  start: {
    label: "Start Events",
    help: [
      "A run starts when one of these Events arrives.",
      "Correlation Path: the payload field that identifies the entity. Runs with the same value belong to the same entity.",
      "With several Events, Concurrency decides what happens to a run already in progress.",
    ],
  },
  cancel: {
    label: "Cancel Events",
    help: [
      "When one of these Events arrives, the runs in progress for its entity are canceled.",
      "The entity is read at the Event's Correlation Path.",
      "A canceled run leaves through the Canceled outlet.",
    ],
  },
} as const;

export function LifecycleEventGroup({
  role,
  rules,
  catalog,
  disabled,
  inputId,
  onEventNamesChange,
  onCorrelationPathChange,
}: {
  role: EventRole;
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
  disabled: boolean;
  inputId: string;
  onEventNamesChange: (eventNames: string[]) => void;
  onCorrelationPathChange: (eventName: string, path: string) => void;
}) {
  const copy = ROLE_COPY[role];
  const eventNames = role === "start" ? rules.startEvents : rules.cancelEvents;

  return (
    <ConfigGroup
      className="py-3 first:pt-0 last:pb-0"
      help={copy.help.map((sentence) => (
        <p key={sentence}>{sentence}</p>
      ))}
      label={copy.label}
    >
      <div className="space-y-2">
        <EventPicker hasEvents={catalog.events.length > 0}>
          <Label className="sr-only" htmlFor={inputId}>
            {copy.label}
          </Label>
          <EventMultiCombobox
            choices={catalogEventChoices(catalog)}
            disabled={disabled}
            inputId={inputId}
            onValueChange={onEventNamesChange}
            value={eventNames}
          />
        </EventPicker>
        {eventNames.map((eventName) => (
          <ChosenEvent
            catalog={catalog}
            disabled={disabled}
            eventName={eventName}
            key={eventName}
            label={findEvent(catalog, eventName)?.label}
            onCommitPath={onCorrelationPathChange}
            onRemove={() =>
              onEventNamesChange(
                eventNames.filter((entry) => entry !== eventName)
              )
            }
            request={correlationPathRequestFor({
              rules,
              catalog,
              eventName,
              role,
            })}
          />
        ))}
      </div>
    </ConfigGroup>
  );
}

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
    // Padded to the height of one row rather than to a card's. An Event with no
    // Correlation Path to ask for is a name and a way to drop it, and sizing
    // that like a card made it the tallest thing in a column of 28px controls.
    <div className="space-y-1.5 rounded-md border px-2 py-1">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs/relaxed" title={eventName}>
          {label ?? eventName}
        </p>
        <Button
          aria-label={`Remove ${eventName}`}
          className="shrink-0"
          disabled={disabled}
          onClick={() => {
            onRemove();
            toast("Event removed", {
              description: "Use Actions > Undo to restore it.",
            });
          }}
          size="icon-sm"
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
      <Label className="text-muted-foreground text-xs" htmlFor={inputId}>
        Correlation Path
        <span className="sr-only">{` for ${eventName}`}</span>
      </Label>
      <Select
        disabled={disabled}
        items={[
          ...(declaredPath ? [] : [{ label: "Choose a path", value: null }]),
          ...paths.map((path) => ({ label: path, value: path })),
        ]}
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
            <SelectItem value={null}>Choose a path</SelectItem>
          )}
          {paths.map((path) => (
            <SelectItem key={path} value={path}>
              {path}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const IDENTIFYING_FIELD_TYPES = new Set(["string", "number"]);

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
