import { useAtomValue } from "jotai";
import { X } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";
import { Button } from "#src/components/ui/button";
import { WarningCallout } from "#src/components/ui/callout";
import { Label } from "#src/components/ui/label";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { getEventConditionFields } from "#src/lib/upstream-node-fields";
import { nodesAtom, selectedNodeAtom } from "#src/lib/workflow-graph-store";
import { findEvent } from "@wfgraph/shared/extensions/catalog";
import {
  createDefaultConditionModel,
  serializeConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import {
  readLifecycleRules,
  resolveCorrelationPath,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import {
  type EventSubscription,
  readWaitSubscriptions,
} from "@wfgraph/shared/lifecycle/wait-subscription";
import { ConditionBuilderRow } from "./condition-builder-row";
import { EventConnectionSelect } from "./event-connection-select";
import { EventMultiCombobox, catalogEventChoices } from "./event-combobox";
import type { UpdateNodeConfig } from "./node-config-patch";

/**
 * The Wait node's subscriptions: which Events resume this run, and what each
 * arrival has to say for it to be this run's.
 *
 * A wait subscribes on its own account, with no lifecycle role, so nothing here
 * says what an Event does to a run: that is the Lifecycle Node's declaration and
 * the builder reads it there. The vocabulary is the app's Events rather than the
 * entry node's, which is what lets a wait park on something the workflow does not
 * start on.
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
  const eventsInputId = useId();

  const selected = readWaitSubscriptions(config);
  const catalog = useExtensionCatalog();

  const selectedNames = selected.map((subscription) => subscription.event);

  const write = (next: EventSubscription[]) => {
    onUpdateConfig({ waitFor: next });
  };

  // A subscription is its Event plus its match, so a selection that survives the
  // edit keeps the match already written against it.
  const setEvents = (eventNames: string[]) => {
    write(
      eventNames.map(
        (eventName) =>
          selected.find((subscription) => subscription.event === eventName) ?? {
            event: eventName,
          }
      )
    );
  };

  const remove = (eventName: string) => {
    write(selected.filter((subscription) => subscription.event !== eventName));
  };

  const patchSubscription = (
    eventName: string,
    patch: Partial<Pick<EventSubscription, "match" | "connectionId">>
  ) => {
    write(
      selected.map((subscription) => {
        if (subscription.event !== eventName) {
          return subscription;
        }
        const next: EventSubscription = {
          event: subscription.event,
          ...(patch.match !== undefined
            ? patch.match
              ? { match: patch.match }
              : {}
            : subscription.match
              ? { match: subscription.match }
              : {}),
          ...(patch.connectionId !== undefined
            ? patch.connectionId
              ? { connectionId: patch.connectionId }
              : {}
            : subscription.connectionId
              ? { connectionId: subscription.connectionId }
              : {}),
        };
        return next;
      })
    );
  };

  const setMatch = (eventName: string, match: string) => {
    patchSubscription(eventName, { match });
  };

  const setConnectionId = (eventName: string, connectionId: string) => {
    patchSubscription(eventName, { connectionId });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={eventsInputId}>Resume when the event is</Label>

        {catalog.events.length > 0 ? (
          <EventMultiCombobox
            choices={catalogEventChoices(catalog)}
            disabled={disabled}
            inputId={eventsInputId}
            onValueChange={setEvents}
            value={selectedNames}
          />
        ) : (
          <p className="text-muted-foreground text-xs">
            This server declares no Events, so there is nothing for a wait to
            park on. Ask whoever runs it to declare the Event.
          </p>
        )}
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
            onConnectionChange={setConnectionId}
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
  onConnectionChange,
  onRemove,
  disabled,
}: {
  subscription: EventSubscription;
  onMatchChange: (eventName: string, match: string) => void;
  onConnectionChange: (eventName: string, connectionId: string) => void;
  onRemove: (eventName: string) => void;
  disabled: boolean;
}) {
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const nodes = useAtomValue(nodesAtom);
  const catalog = useExtensionCatalog();
  const event = findEvent(catalog, subscription.event);

  // The entry node's rules, if this graph has one, so the seed below can read
  // this workflow's own Correlation Path rather than the Event Author's
  // declaration -- the two disagree the moment the Lifecycle panel overrides one.
  const entryRules = useMemo(
    () =>
      nodes
        .filter((node) => node.data.type === "lifecycle")
        .map((node) => readLifecycleRules(node.data.config))
        .find((rules) => rules !== undefined),
    [nodes]
  );

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

  /**
   * Whether this row's match was seeded by the button below rather than loaded
   * with the workflow. The rule builder mounts the moment a match exists, and
   * this is what has it open on its controls: one click for a match the builder
   * still has to fill in, rather than a summary and then an Edit.
   */
  const [seededHere, setSeededHere] = useState(false);

  const handleClear = useCallback(() => {
    onMatchChange(subscription.event, "");
    setSeededHere(false);
  }, [onMatchChange, subscription.event]);

  // The comparison the common case wants, offered as one click: the arriving
  // payload at this workflow's Correlation Path for the Event, against whatever
  // the builder puts on the right. `payload.` is not in the path, because the
  // compiler roots it. Without an entry node to read rules from, the Event's own
  // declaration is the best guess available.
  const seedPath = useMemo(
    () =>
      entryRules
        ? resolveCorrelationPath({
            rules: entryRules,
            eventName: subscription.event,
            declaredPath: event?.correlationPath,
          })
        : event?.correlationPath,
    [entryRules, event?.correlationPath, subscription.event]
  );

  const seedMatch = useCallback(() => {
    const seedField =
      fields.find((field) => field.path === seedPath) ?? fields[0];
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
    setSeededHere(true);
  }, [seedPath, fields, onMatchChange, subscription.event]);

  return (
    <div className="space-y-2 rounded-md border p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0" title={subscription.event}>
          {event ? <p className="truncate text-xs">{event.label}</p> : null}
          <p className="truncate font-mono text-xs text-muted-foreground">
            {subscription.event}
          </p>
          {event ? null : (
            <p className="text-destructive text-xs">
              This app no longer declares this Event; the workflow will not save
              until it is removed or declared again.
            </p>
          )}
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

      {event?.integration ? (
        <EventConnectionSelect
          catalog={catalog}
          disabled={disabled}
          eventName={subscription.event}
          onChange={(id) => onConnectionChange(subscription.event, id)}
          value={subscription.connectionId}
        />
      ) : null}

      {subscription.match ? (
        <>
          <ConditionBuilderRow
            currentNodeId={selectedNodeId ?? undefined}
            defaultEditing={seededHere}
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
