import * as stylex from "@stylexjs/stylex";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Selector } from "@astryxdesign/core/Selector";
import { Section } from "@astryxdesign/core/Section";
import { Text } from "@astryxdesign/core/Text";
import { TimeInput } from "@astryxdesign/core/TimeInput";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { VStack } from "@astryxdesign/core/VStack";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { HelpCircle, Plus, Settings, Zap } from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";
import { ConfigureConnectionOverlay } from "#src/components/overlays/add-connection-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { IntegrationIcon } from "#src/components/integration-icon";
import { IntegrationSelector } from "#src/components/form-fields/integration-selector";
import { TemplateBadgeInput } from "#src/components/form-fields/template-badge-input";
import { TimezoneSelect } from "#src/components/form-fields/timezone-select";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { useEventSplitOutlets } from "#src/lib/event-split-outlets";
import { toISOTimeString } from "#src/lib/astryx-input-values";
import { getUpstreamConditionFields } from "#src/lib/upstream-node-fields";
import {
  edgesAtom,
  nodesAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import {
  actionsForPickerByCategory,
  findAction,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import {
  DEFAULT_WAIT_TIMEOUT,
  readWaitDelayTiming,
  WAIT_VALUE_TARGETS,
  waitValueKeysNotIn,
} from "@wfgraph/shared/lifecycle/wait-subscription";
import { ActionConfigRenderer } from "./action-config-renderer";
import { ConditionBuilderRow } from "./condition-builder-row";
import type { UpdateNodeConfig } from "./node-config-patch";
import { WaitEventSelect } from "./wait-event-select";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import {
  readConfigString,
  readConfigStringOr,
} from "@wfgraph/shared/graph/node-config";

type ActionConfigProps = {
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled: boolean;
  isOwner?: boolean;
};

type CategoryActionOption = {
  id: string;
  label: string;
  logoUrl?: string;
  integration?: string;
};

function OptionLogo({
  logoUrl,
  label,
  fallback,
}: {
  logoUrl?: string;
  label: string;
  fallback: ReactNode;
}) {
  const normalizedLogoUrl = logoUrl?.trim();

  if (!normalizedLogoUrl) {
    return fallback;
  }

  return (
    <img
      alt={`${label} logo`}
      height={16}
      loading="lazy"
      src={normalizedLogoUrl}
      width={16}
      {...stylex.props(styles.logo)}
    />
  );
}

/**
 * The Condition node's rule builder, over what the nodes above it produce.
 *
 * The model and the CEL it compiles to are both stored, because the save path
 * checks one against the other before a run is allowed to read either.
 */
function ConditionFields({
  config,
  onUpdateConfig,
  disabled,
}: {
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled: boolean;
}) {
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);

  const catalog = useExtensionCatalog();
  const fields = useMemo(
    () =>
      getUpstreamConditionFields({
        currentNodeId: selectedNodeId ?? undefined,
        nodes,
        edges,
        catalog,
      }),
    [selectedNodeId, nodes, edges, catalog]
  );

  const handleChange = useCallback(
    (next: { model: string; expression: string }) => {
      onUpdateConfig({
        conditionModel: next.model,
        condition: next.expression,
      });
    },
    [onUpdateConfig]
  );

  return (
    <Section padding={3} variant="muted">
      <ConditionBuilderRow
        currentNodeId={selectedNodeId ?? undefined}
        description="Build a condition from the Lifecycle Node and upstream action output fields. Timestamp fields support relative and absolute time filters."
        disabled={disabled}
        emptyFieldsMessage="No upstream fields available. Connect this node to the Lifecycle Node or an action with typed outputs first."
        fields={fields}
        label="Condition"
        onChange={handleChange}
        value={readConfigString(config, "conditionModel") ?? ""}
      />
    </Section>
  );
}

/**
 * What the Event Split node splits on, which is a fact of the graph rather than
 * anything to fill in.
 *
 * Its outlets are the Events that can reach it, so the panel states them and the
 * canvas draws one handle each. A node nothing reaches has no outlets, and
 * saying so here is the only place a builder finds out why the card has no
 * handles to drag from.
 */
function EventSplitFields() {
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const outlets = useEventSplitOutlets(selectedNodeId);

  return (
    <Section padding={3} variant="muted">
      <VStack gap={3}>
        <Text type="label">Splits on Event</Text>

        {outlets.length === 0 ? (
          <Text color="secondary" type="supporting">
            No Event reaches this node yet. Connect it below the Lifecycle Node,
            and it draws one outlet per Start Event.
          </Text>
        ) : (
          <>
            <VStack as="ul" gap={1} xstyle={styles.list}>
              {outlets.map((event) => (
                <li key={event.name}>
                  <HStack gap={2}>
                    <Text>{event.label}</Text>
                    <Text color="secondary" type="supporting">
                      {event.name}
                    </Text>
                  </HStack>
                </li>
              ))}
            </VStack>
            <Text color="secondary" type="supporting">
              A run leaves by the outlet naming the Event it arrived on. An
              outlet with nothing connected ends the run there.
            </Text>
          </>
        )}
      </VStack>
    </Section>
  );
}

type WaitFieldProps = {
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled: boolean;
};

function DelayWaitFields({ config, onUpdateConfig, disabled }: WaitFieldProps) {
  const waitGateMode = readConfigStringOr(config, "waitGateMode", "off");
  const configuredWaitUntil = readConfigString(config, "waitUntil");
  const configuredWaitDuration = readConfigString(config, "waitDuration");
  const delayTimingMode = readWaitDelayTiming(config);
  const isWindowEnabled =
    readConfigString(config, "waitAllowedHoursMode") === "daily_window";

  // Switching timing drops the fields the timing being left owned, so a run
  // never reads a stale duration next to a freshly chosen target date.
  const handleDelayTimingModeChange = (value: string) => {
    const next = { ...config, waitDelayTimingMode: value };
    const cleared = Object.fromEntries(
      waitValueKeysNotIn(next).map((key) => [key, ""])
    );

    onUpdateConfig({ ...cleared, waitDelayTimingMode: value });
  };

  return (
    <Section padding={3} variant="muted">
      <VStack gap={3}>
        <Text type="label">Time-based wait</Text>

        <Selector
          description="Pick one mode. Switching modes clears fields that do not apply."
          isDisabled={disabled}
          label="Time input mode"
          onChange={handleDelayTimingModeChange}
          options={[
            { value: "duration", label: "Wait for duration" },
            { value: "until", label: "Wait until date/time" },
          ]}
          placement="below"
          value={delayTimingMode}
          width="100%"
        />

        {delayTimingMode === "duration" ? (
          <VStack gap={2}>
            <Text id="waitDuration-label" type="label">
              Wait for (duration)
            </Text>
            <TemplateBadgeInput
              disabled={disabled}
              fieldType={WAIT_VALUE_TARGETS.waitDuration.type}
              id="waitDuration"
              labelledBy="waitDuration-label"
              onChange={(value) => onUpdateConfig({ waitDuration: value })}
              placeholder="24h, 90m, 3600000, or P1D"
              value={configuredWaitDuration}
            />
            <Text color="secondary" type="supporting">
              Example: use 24h to continue one day later.
            </Text>
          </VStack>
        ) : (
          <>
            <VStack gap={2}>
              <Text id="waitUntil-label" type="label">
                Wait until this date/time
              </Text>
              <TemplateBadgeInput
                disabled={disabled}
                fieldType={WAIT_VALUE_TARGETS.waitUntil.type}
                id="waitUntil"
                labelledBy="waitUntil-label"
                onChange={(value) => onUpdateConfig({ waitUntil: value })}
                placeholder="2026-03-10T09:00:00-05:00 or {{@lifecycle_1:Lifecycle.appointment.startsAt}}"
                value={configuredWaitUntil}
              />
              <Text color="secondary" type="supporting">
                Use this when timing comes from payload data, like an
                appointment start time.
              </Text>
            </VStack>

            <VStack gap={2}>
              <Text id="waitOffset-label" type="label">
                Send before/after that time (optional)
              </Text>
              <TemplateBadgeInput
                disabled={disabled}
                fieldType={WAIT_VALUE_TARGETS.waitOffset.type}
                id="waitOffset"
                labelledBy="waitOffset-label"
                onChange={(value) => onUpdateConfig({ waitOffset: value })}
                placeholder="-1d, 6h, 30m"
                value={readConfigString(config, "waitOffset")}
              />
              <Text color="secondary" type="supporting">
                Example: -1d sends one day before the target time.
              </Text>
            </VStack>
          </>
        )}

        <Selector
          description="Prevents immediate sends when the computed time is now or in the past after an update or reschedule."
          isDisabled={disabled}
          label="Continue only if time actually elapsed"
          onChange={(value) => onUpdateConfig({ waitGateMode: value })}
          options={[
            { value: "off", label: "Off (continue immediately)" },
            {
              value: "require_actual_wait",
              label: "Skip branch when already due",
            },
          ]}
          placement="below"
          value={waitGateMode}
          width="100%"
        />

        <Selector
          description="When enabled, times outside the window shift to the next allowed start."
          isDisabled={disabled}
          label="Allowed send window"
          onChange={(value) => onUpdateConfig({ waitAllowedHoursMode: value })}
          options={[
            { value: "off", label: "Off (allow any time)" },
            { value: "daily_window", label: "Daily window" },
          ]}
          placement="below"
          value={readConfigStringOr(config, "waitAllowedHoursMode", "off")}
          width="100%"
        />

        {isWindowEnabled && (
          <VStack gap={2}>
            <Grid columns={2} gap={2}>
              <TimeInput
                isDisabled={disabled}
                label="Window start"
                onChange={(value) =>
                  onUpdateConfig({ waitAllowedStartTime: value ?? "" })
                }
                placeholder="09:00"
                value={toISOTimeString(
                  readConfigString(config, "waitAllowedStartTime")
                )}
              />
              <TimeInput
                isDisabled={disabled}
                label="Window end"
                onChange={(value) =>
                  onUpdateConfig({ waitAllowedEndTime: value ?? "" })
                }
                placeholder="17:00"
                value={toISOTimeString(
                  readConfigString(config, "waitAllowedEndTime")
                )}
              />
            </Grid>
            <Text color="secondary" type="supporting">
              Use 24-hour format (HH:MM). Start must be before end. Requires
              timezone below.
            </Text>
          </VStack>
        )}

        <VStack gap={2}>
          <TimezoneSelect
            disabled={disabled}
            label={`Timezone${isWindowEnabled ? " (required for send window)" : " (optional)"}`}
            onValueChange={(value) => onUpdateConfig({ waitTimezone: value })}
            value={readConfigStringOr(config, "waitTimezone", "UTC")}
          />
          <Text color="secondary" type="supporting">
            Used when the target date/time does not include an offset.
            {isWindowEnabled &&
              " Also determines when the daily send window applies."}
          </Text>
        </VStack>
      </VStack>
    </Section>
  );
}

function EventWaitFields({ config, onUpdateConfig, disabled }: WaitFieldProps) {
  return (
    <Section padding={3} variant="muted">
      <VStack gap={3}>
        <Text type="label">Wait for Event</Text>
        <WaitEventSelect
          config={config}
          disabled={disabled}
          onUpdateConfig={onUpdateConfig}
        />

        <VStack gap={2}>
          <Text id="waitTimeout-label" type="label">
            Stop waiting after
          </Text>
          <TemplateBadgeInput
            disabled={disabled}
            fieldType={WAIT_VALUE_TARGETS.waitTimeout.type}
            id="waitTimeout"
            labelledBy="waitTimeout-label"
            onChange={(value) => onUpdateConfig({ waitTimeout: value })}
            placeholder={DEFAULT_WAIT_TIMEOUT}
            value={readConfigString(config, "waitTimeout")}
          />
          <Text color="secondary" type="supporting">
            Required. A wait with no end holds a run, and a place in the run
            list, until somebody notices.
          </Text>
        </VStack>

        <Selector
          description="Choose whether to continue downstream nodes or halt the branch when the timeout expires."
          isDisabled={disabled}
          label="On timeout"
          onChange={(value) => onUpdateConfig({ waitTimeoutBehavior: value })}
          options={[
            { value: "continue", label: "Continue workflow" },
            { value: "skip", label: "Skip remaining branch" },
          ]}
          placement="below"
          value={readConfigStringOr(config, "waitTimeoutBehavior", "continue")}
          width="100%"
        />
      </VStack>
    </Section>
  );
}

/**
 * The Wait node's two modes: resume on a clock, or resume on an Event.
 *
 * Choosing the event mode writes the timeout default in the same handler, so the
 * common case costs no thought and the save rule that requires one is satisfied
 * before a builder ever meets it.
 */
function WaitFields({ config, onUpdateConfig, disabled }: WaitFieldProps) {
  const waitMode = readConfigStringOr(config, "waitMode", "delay");

  // Switching mode drops the keys the shape being left owned, the same rule the
  // timing selector below follows: a run never reads a value from a shape the
  // node is no longer in, and a builder is never refused over an input that is
  // off screen.
  const handleModeChange = (value: string) => {
    const next = { ...config, waitMode: value };
    const cleared = Object.fromEntries(
      waitValueKeysNotIn(next).map((key) => [key, ""])
    );

    onUpdateConfig({
      ...cleared,
      waitMode: value,
      ...(value === "event" &&
      !(readConfigString(config, "waitTimeout") ?? "").trim()
        ? { waitTimeout: DEFAULT_WAIT_TIMEOUT }
        : {}),
    });
  };

  return (
    <>
      <Selector
        description="Resume on a clock, or when an event arrives that this step's match accepts."
        isDisabled={disabled}
        label="How should this step wait?"
        onChange={handleModeChange}
        options={[
          { value: "delay", label: "Wait for time" },
          { value: "event", label: "Wait for an Event" },
        ]}
        placement="below"
        value={waitMode}
        width="100%"
      />

      {waitMode === "delay" && (
        <DelayWaitFields
          config={config}
          disabled={disabled}
          onUpdateConfig={onUpdateConfig}
        />
      )}

      {waitMode === "event" && (
        <EventWaitFields
          config={config}
          disabled={disabled}
          onUpdateConfig={onUpdateConfig}
        />
      )}
    </>
  );
}

// System action fields wrapper - extracts conditional rendering to reduce complexity
function SystemActionFields({
  actionType,
  config,
  onUpdateConfig,
  disabled,
}: {
  actionType: string;
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled: boolean;
}) {
  switch (actionType) {
    case BUILT_IN_ACTION_IDS.condition:
      return (
        <ConditionFields
          config={config}
          disabled={disabled}
          onUpdateConfig={onUpdateConfig}
        />
      );
    case BUILT_IN_ACTION_IDS.eventSplit:
      return <EventSplitFields />;
    case BUILT_IN_ACTION_IDS.wait:
      return (
        <WaitFields
          config={config}
          disabled={disabled}
          onUpdateConfig={onUpdateConfig}
        />
      );
    default:
      return null;
  }
}

/**
 * Every category the selector offers, and the actions in each.
 *
 * Condition and Wait are catalog entries in the "System" category like any
 * other action, so this reads one list: an editor served by a different build
 * than its server offers what that server can run.
 */
function useCategoryData(
  pinnedActionId?: string
): Record<string, CategoryActionOption[]> {
  const catalog = useExtensionCatalog();
  return useMemo(() => {
    const grouped = actionsForPickerByCategory(catalog, pinnedActionId);

    return Object.fromEntries(
      Object.entries(grouped).map(([category, actions]) => [
        category,
        actions.map((action) => ({
          id: action.id,
          label: action.label,
          logoUrl: action.logoUrl,
          integration: action.integration,
        })),
      ])
    );
  }, [catalog, pinnedActionId]);
}

function getCategoryForAction(
  catalog: ExtensionCatalog,
  actionType: string
): string | null {
  return findAction(catalog, actionType)?.category ?? null;
}

export function ActionConfig({
  config,
  onUpdateConfig,
  disabled,
  isOwner = true,
}: ActionConfigProps) {
  const catalog = useExtensionCatalog();
  const actionType = readConfigString(config, "actionType");
  const categories = useCategoryData(actionType);
  const categoryOptions = useMemo(
    () =>
      Object.keys(categories)
        .filter((name) => name !== "System")
        .toSorted(),
    [categories]
  );

  const category = actionType
    ? getCategoryForAction(catalog, actionType) || ""
    : "";
  const { data: globalIntegrations = [] } = useQuery(
    integrationsQueryOptions()
  );
  const { push } = useOverlay();

  const handleCategoryChange = (newCategory: string) => {
    const firstAction = categories[newCategory]?.[0];
    if (firstAction) {
      onUpdateConfig({ actionType: firstAction.id });
    }
  };

  const handleActionTypeChange = (value: string) => {
    onUpdateConfig({ actionType: value });
  };

  const catalogAction = actionType
    ? findAction(catalog, actionType)
    : undefined;

  // Which connection this action needs, which the catalog answers for every
  // action alike.
  const integrationType = catalogAction?.integration;

  const hasExistingConnections = globalIntegrations.some(
    (integration) => integration.type === integrationType
  );

  const openConnectionOverlay = () => {
    if (integrationType) {
      push(ConfigureConnectionOverlay, {
        type: integrationType,
        // The write refreshes the connection list before this runs, and
        // updateConfig reads that list from the cache rather than from the
        // render this callback was captured in. Both halves are needed, or the
        // repair rebinds the node to the connection it had before.
        onSuccess: (integrationId: string) => {
          onUpdateConfig({ integrationId });
        },
      });
    }
  };

  return (
    <>
      <Grid columns={2} gap={2}>
        <Selector
          isDisabled={disabled}
          label="Service"
          onChange={handleCategoryChange}
          options={[
            {
              value: "System",
              label: "System",
              icon: <Icon icon={Settings} size="sm" />,
            },
            ...categoryOptions.map((categoryName) => {
              const actionsInCategory = categories[categoryName];
              const categoryIntegration = actionsInCategory?.[0]?.integration;
              const categoryLogoUrl = actionsInCategory
                ?.map((action) => action.logoUrl)
                .find(
                  (value) =>
                    typeof value === "string" && value.trim().length > 0
                );
              const fallbackIcon = categoryIntegration ? (
                <IntegrationIcon integration={categoryIntegration} />
              ) : (
                <Icon icon={Zap} size="sm" />
              );
              return {
                value: categoryName,
                label: categoryName,
                icon: (
                  <OptionLogo
                    fallback={fallbackIcon}
                    label={categoryName}
                    logoUrl={categoryLogoUrl}
                  />
                ),
              };
            }),
          ]}
          placement="below"
          placeholder="Select service"
          value={category || undefined}
          width="100%"
        />

        <Selector
          isDisabled={disabled || !category}
          label="Action"
          onChange={handleActionTypeChange}
          options={(category ? (categories[category] ?? []) : []).map(
            (action) => {
              const fallbackIcon =
                category === "System" ? (
                  <Icon icon={Settings} size="sm" />
                ) : action.integration ? (
                  <IntegrationIcon integration={action.integration} />
                ) : (
                  <Icon icon={Zap} size="sm" />
                );
              return {
                value: action.id,
                label: action.label,
                icon: (
                  <OptionLogo
                    fallback={fallbackIcon}
                    label={action.label}
                    logoUrl={action.logoUrl}
                  />
                ),
              };
            }
          )}
          placement="below"
          placeholder="Select action"
          value={actionType || undefined}
          width="100%"
        />
      </Grid>

      {integrationType && isOwner && (
        <VStack gap={2}>
          <HStack align="center" justify="between">
            <HStack align="center" gap={1}>
              <Text type="label">Connection</Text>
              <Tooltip content="API key or OAuth credentials for this service">
                <IconButton
                  icon={<Icon icon={HelpCircle} size="sm" />}
                  label="Connection help"
                  size="sm"
                  variant="ghost"
                />
              </Tooltip>
            </HStack>
            {hasExistingConnections && (
              <IconButton
                icon={<Icon icon={Plus} size="sm" />}
                isDisabled={disabled}
                label="Add connection"
                onClick={openConnectionOverlay}
                size="sm"
                variant="ghost"
              />
            )}
          </HStack>
          <IntegrationSelector
            disabled={disabled}
            integrationType={integrationType}
            onChange={(id) => onUpdateConfig({ integrationId: id })}
            value={readConfigString(config, "integrationId")}
          />
        </VStack>
      )}

      {/* System actions - hardcoded config fields */}
      <SystemActionFields
        actionType={readConfigString(config, "actionType") ?? ""}
        config={config}
        disabled={disabled}
        onUpdateConfig={onUpdateConfig}
      />

      {/* Declarative config fields. Condition and Wait declare none: each is
          drawn by a panel of its own above, written against the shape it has. */}
      {catalogAction && catalogAction.configFields.length > 0 && (
        <ActionConfigRenderer
          config={config}
          disabled={disabled}
          fields={catalogAction.configFields}
          onUpdateConfig={onUpdateConfig}
        />
      )}
    </>
  );
}

const styles = stylex.create({
  logo: {
    borderRadius: "var(--radius-element)",
    height: 16,
    objectFit: "contain",
    width: 16,
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
});
