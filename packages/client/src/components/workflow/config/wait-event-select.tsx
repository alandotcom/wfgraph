import { useAtomValue } from "jotai";
import { Plus, X } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";
import { Button } from "#src/components/ui/button";
import { WarningCallout } from "#src/components/ui/callout";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import { getExtensionCatalog } from "#src/lib/extensions";
import { getEventConditionFields } from "#src/lib/upstream-node-fields";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import { findEvent } from "@rova/shared/extensions/catalog";
import {
  createDefaultConditionModel,
  serializeConditionModel,
} from "@rova/shared/workflow/conditions";
import {
  type EventSubscription,
  readWaitSubscriptions,
} from "@rova/shared/workflow/wait-subscription";
import { ConditionBuilderRow } from "./condition-builder-row";
import { EventChipGroup } from "./event-chip-group";
import type { UpdateNodeConfig } from "./node-config-patch";

/**
 * The Wait node's subscriptions: which Events resume this run, and what each
 * arrival has to say for it to be this run's.
 *
 * A wait subscribes on its own account, with no lifecycle role, so nothing here
 * says what an Event does to a run: that is the Lifecycle Node's declaration and
 * the builder reads it there. The vocabulary is the app's Events rather than the
 * entry node's, which is what lets a wait park on something the workflow does not
 * start on, and an Event the catalog does not name can still be typed in -- a host
 * may send one to the bus that it never declared.
 *
 * A match is the Condition node's model, stored per subscription and evaluated
 * against the arriving payload. Its right-hand side takes a literal or a template
 * token, and the run side of a token is resolved to a literal when the run parks.
 */
export function WaitEventSelect({
  config,
  onUpdateConfig,
  disabled,
}: {
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled: boolean;
}) {
  const chipGroupLabelId = useId();
  const [draftEventType, setDraftEventType] = useState("");

  const selected = readWaitSubscriptions(config);
  const catalog = getExtensionCatalog();

  const selectedNames = selected.map((subscription) => subscription.event);
  const declared = new Set(catalog.events.map((event) => event.name));
  // Every selection is a chip, declared or typed in, so nothing the builder
  // chose is ever invisible. A name the catalog does not carry has no label but
  // its own.
  const choices = [
    ...catalog.events.map((event) => ({
      name: event.name,
      label: event.label,
    })),
    ...selectedNames
      .filter((eventName) => !declared.has(eventName))
      .map((eventName) => ({ name: eventName, label: eventName })),
  ];

  const write = (next: EventSubscription[]) => {
    onUpdateConfig({ waitFor: next });
  };

  const add = (eventName: string) => {
    if (selectedNames.includes(eventName)) {
      return;
    }
    write([...selected, { event: eventName }]);
  };

  const remove = (eventName: string) => {
    write(selected.filter((subscription) => subscription.event !== eventName));
  };

  const setMatch = (eventName: string, match: string) => {
    write(
      selected.map((subscription) =>
        subscription.event === eventName
          ? { event: subscription.event, ...(match ? { match } : {}) }
          : subscription
      )
    );
  };

  const normalizedDraft = draftEventType.trim();
  const handleAddDraft = () => {
    if (!normalizedDraft) {
      return;
    }
    add(normalizedDraft);
    setDraftEventType("");
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label id={chipGroupLabelId}>Resume when the event is</Label>

        {choices.length > 0 ? (
          <EventChipGroup
            choices={choices}
            disabled={disabled}
            labelId={chipGroupLabelId}
            onToggle={(eventName) =>
              selectedNames.includes(eventName)
                ? remove(eventName)
                : add(eventName)
            }
            selected={selectedNames}
          />
        ) : (
          <p className="text-muted-foreground text-xs">
            This server declares no Events. Name the one this wait parks on
            below, or ask whoever runs it to declare the Event.
          </p>
        )}

        <div className="flex items-center gap-2">
          <Input
            disabled={disabled}
            onChange={(event) => setDraftEventType(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleAddDraft();
              }
            }}
            placeholder="app/appointment.confirmed"
            value={draftEventType}
          />
          <Button
            disabled={disabled || !normalizedDraft}
            onClick={handleAddDraft}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="size-3.5" />
            Add
          </Button>
        </div>
      </div>

      {selected.length === 0 ? (
        <WarningCallout>
          Name at least one event. A wait with none cannot be resumed by
          anything, and the workflow will not save.
        </WarningCallout>
      ) : (
        selected.map((subscription) => (
          <WaitSubscriptionRow
            disabled={disabled}
            key={subscription.event}
            onMatchChange={setMatch}
            onRemove={remove}
            subscription={subscription}
          />
        ))
      )}
    </div>
  );
}

/** One subscription: the Event it names, and the match that narrows it. */
function WaitSubscriptionRow({
  subscription,
  onMatchChange,
  onRemove,
  disabled,
}: {
  subscription: EventSubscription;
  onMatchChange: (eventName: string, match: string) => void;
  onRemove: (eventName: string) => void;
  disabled: boolean;
}) {
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const catalog = getExtensionCatalog();
  const event = findEvent(catalog, subscription.event);

  const fields = useMemo(
    () => getEventConditionFields(catalog, subscription.event),
    [catalog, subscription.event]
  );

  const handleChange = useCallback(
    (next: { model: string; expression: string }) => {
      onMatchChange(subscription.event, next.model);
    },
    [onMatchChange, subscription.event]
  );

  const handleClear = useCallback(() => {
    onMatchChange(subscription.event, "");
  }, [onMatchChange, subscription.event]);

  // The comparison the common case wants, offered as one click: the arriving
  // payload at this Event's Correlation Path, against whatever the builder puts
  // on the right. `payload.` is not in the path, because the compiler roots it.
  const seedMatch = useCallback(() => {
    const seedField =
      fields.find((field) => field.path === event?.correlationPath) ??
      fields[0];
    if (!seedField) {
      return;
    }

    onMatchChange(
      subscription.event,
      serializeConditionModel(
        createDefaultConditionModel(seedField, {
          groupId: `${subscription.event}-group`,
          conditionId: `${subscription.event}-rule`,
        })
      )
    );
  }, [event?.correlationPath, fields, onMatchChange, subscription.event]);

  return (
    <div className="space-y-2 rounded-md border p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0" title={subscription.event}>
          {event ? <p className="truncate text-xs">{event.label}</p> : null}
          <p className="truncate font-mono text-[10px] text-muted-foreground">
            {subscription.event}
          </p>
        </div>
        <Button
          aria-label={`Remove ${subscription.event}`}
          className="size-7 shrink-0"
          disabled={disabled}
          onClick={() => onRemove(subscription.event)}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X className="size-3.5" />
        </Button>
      </div>

      {event ? null : (
        <WarningCallout variant="text">
          This server declares no such Event, so its fields are unknown here.
          The wait still parks on the name, and still wakes on a match if
          something sends it.
        </WarningCallout>
      )}

      {subscription.match ? (
        <>
          <ConditionBuilderRow
            currentNodeId={selectedNodeId ?? undefined}
            description="Only an arrival satisfying this resumes the run. Compare a payload field against a literal, or against a value from this run."
            disabled={disabled}
            emptyFieldsMessage="This Event declares no fields, so there is nothing to match on."
            fields={fields}
            label="Match"
            onChange={handleChange}
            value={subscription.match}
          />
          <Button
            disabled={disabled}
            onClick={handleClear}
            size="sm"
            type="button"
            variant="ghost"
          >
            Resume on any {subscription.event}
          </Button>
        </>
      ) : (
        <div className="space-y-1">
          <p className="text-muted-foreground text-xs">
            Any {subscription.event} resumes this run, whatever it carries.
          </p>
          <Button
            disabled={disabled || fields.length === 0}
            onClick={seedMatch}
            size="sm"
            type="button"
            variant="outline"
          >
            Add a match
          </Button>
        </div>
      )}
    </div>
  );
}
