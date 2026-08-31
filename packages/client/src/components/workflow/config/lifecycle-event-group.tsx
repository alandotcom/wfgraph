import { compact, uniq } from "es-toolkit";
import { X } from "lucide-react";
import { type ReactNode, useId } from "react";
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
import { ConfigGroup, ConfigViewEmpty } from "./config-section";
import { EventMultiCombobox } from "./event-combobox";

type EventRole = "start" | "cancel";

const ROLE_COPY = {
  start: {
    label: "Start Events",
    empty: "No Start Events.",
    help: [
      "A run starts when one of these Events arrives.",
      "Correlation Path: the payload field that identifies the entity. Runs with the same value belong to the same entity.",
      "With several Events, Concurrency decides what happens to a run already in progress.",
    ],
  },
  cancel: {
    label: "Cancel Events",
    empty: "No Cancel Events.",
    help: [
      "When one of these Events arrives, the runs in progress for its entity are canceled.",
      "The entity is read at the Event's Correlation Path.",
      "A canceled run leaves through the Canceled outlet.",
    ],
  },
} as const;

export function LifecycleEventGroup({
  role,
  editing,
  rules,
  catalog,
  disabled,
  inputId,
  onEventNamesChange,
  onCorrelationPathChange,
}: {
  role: EventRole;
  editing: boolean;
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
      {editing ? (
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
      ) : (
        <ChosenEventSummary
          catalog={catalog}
          empty={copy.empty}
          eventNames={eventNames}
          role={role}
          rules={rules}
        />
      )}
    </ConfigGroup>
  );
}

function ChosenEventSummary({
  eventNames,
  role,
  rules,
  catalog,
  empty,
}: {
  eventNames: readonly string[];
  role: EventRole;
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
  empty: string;
}) {
  if (eventNames.length === 0) {
    return <ConfigViewEmpty>{empty}</ConfigViewEmpty>;
  }

  return (
    <div className="space-y-2">
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
    </div>
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
