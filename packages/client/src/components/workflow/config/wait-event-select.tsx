import * as stylex from "@stylexjs/stylex";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { colorVars } from "@astryxdesign/core/theme/tokens.stylex";
import { useAtomValue } from "jotai";
import { X } from "lucide-react";
import { useCallback, useMemo } from "react";
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
import { EventMultiCombobox } from "./event-combobox";
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

  const setMatch = (eventName: string, match: string) => {
    write(
      selected.map((subscription) =>
        subscription.event === eventName
          ? { event: subscription.event, ...(match ? { match } : {}) }
          : subscription
      )
    );
  };

  return (
    <VStack gap={3}>
      <VStack gap={2}>
        <Text type="label">Resume when the event is</Text>

        {catalog.events.length > 0 ? (
          <EventMultiCombobox
            choices={catalog.events}
            disabled={disabled}
            inputId="wait-events"
            label="Resume when the event is"
            onValueChange={setEvents}
            value={selectedNames}
          />
        ) : (
          <Text color="secondary" type="supporting">
            This server declares no Events, so there is nothing for a wait to
            park on. Ask whoever runs it to declare the Event.
          </Text>
        )}
      </VStack>

      {selected.length === 0 ? (
        <Banner
          description="A wait with none cannot be resumed by anything, and the workflow will not save."
          status="warning"
          title="Name at least one event"
        />
      ) : (
        <List density="spacious" hasDividers>
          {selected.map((subscription) => (
            <WaitSubscriptionRow
              disabled={disabled}
              key={subscription.event}
              onMatchChange={setMatch}
              onRemove={remove}
              subscription={subscription}
            />
          ))}
        </List>
      )}
    </VStack>
  );
}

/**
 * One subscription: the Event it names, and the match that narrows it.
 *
 * A row, not a box: the event name is the heading and a divider separates
 * subscriptions, so the section card above stays the only frame on this panel.
 */
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

  const handleClear = useCallback(() => {
    onMatchChange(subscription.event, "");
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
  }, [seedPath, fields, onMatchChange, subscription.event]);

  return (
    <ListItem
      description={
        <VStack gap={2}>
          {event ? (
            <Text maxLines={1} type="code">
              {subscription.event}
            </Text>
          ) : null}
          {event ? null : (
            <Text type="supporting" xstyle={styles.errorText}>
              This app no longer declares this Event; the workflow will not save
              until it is removed or declared again.
            </Text>
          )}
          {subscription.match ? (
            <VStack gap={2}>
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
                isDisabled={disabled}
                label={`Resume on any ${subscription.event}`}
                onClick={handleClear}
                size="sm"
                variant="ghost"
              />
            </VStack>
          ) : (
            <VStack gap={1}>
              <Text color="secondary" type="supporting">
                Any {subscription.event} resumes this run, whatever it carries.
              </Text>
              <Button
                isDisabled={disabled || fields.length === 0}
                label="Add a match"
                onClick={seedMatch}
                size="sm"
                variant="secondary"
              />
            </VStack>
          )}
        </VStack>
      }
      endContent={
        <IconButton
          icon={<Icon icon={X} size="sm" />}
          isDisabled={disabled}
          label={`Remove ${subscription.event}`}
          onClick={() => onRemove(subscription.event)}
          size="sm"
          tooltip={`Remove ${subscription.event}`}
          variant="ghost"
        />
      }
      label={event?.label ?? subscription.event}
    />
  );
}

const styles = stylex.create({
  errorText: {
    color: colorVars["--color-text-red"],
  },
});
