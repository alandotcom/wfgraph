import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { HelpCircle, Settings, Zap } from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";
import { mapValues } from "es-toolkit/object";
import { isBlank } from "@wfgraph/shared/types/string";
import { Input } from "#src/components/ui/input";
import { IntegrationIcon } from "#src/components/ui/integration-icon";
import { IntegrationSelector } from "#src/components/ui/integration-selector";
import { Label } from "#src/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "#src/components/ui/select";
import { whenChosen } from "#src/lib/select-choice";
import { TemplateBadgeInput } from "#src/components/ui/template-badge-input";
import { TimezoneSelect } from "#src/components/ui/timezone-select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#src/components/ui/tooltip";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  EVENT_SPLIT_HEADING,
  EVENT_SPLIT_NO_SOURCE_TEXT,
  useEventSplitOutlets,
} from "#src/lib/event-split-outlets";
import {
  type ConditionSelectableField,
  getUpstreamConditionFields,
} from "#src/lib/upstream-node-fields";
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
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  DEFAULT_WAIT_TIMEOUT,
  readWaitDelayTiming,
  WAIT_VALUE_TARGETS,
  waitValueKeysNotIn,
} from "@wfgraph/shared/lifecycle/wait-subscription";
import { ActionConfigRenderer } from "./action-config-renderer";
import { ConditionBuilderRow } from "./condition-builder-row";
import { ConfigHelp } from "./config-section";
import type { UpdateNodeConfig } from "./node-config-patch";
import { WaitEventSelect } from "./wait-event-select";
import {
  WAIT_DELAY_TIMING_OPTIONS,
  WAIT_FIELD_LABELS,
  WAIT_GATE_OPTIONS,
  WAIT_MODE_OPTIONS,
  WAIT_TIMEOUT_OPTIONS,
  WAIT_WINDOW_OPTIONS,
} from "./wait-options";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import { can } from "#src/lib/authorization";
import { settledProviderParameter } from "#src/lib/provider-parameters";
import {
  readConfigString,
  readConfigStringOr,
} from "@wfgraph/shared/graph/node-config";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

type ActionConfigProps = {
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled: boolean;
  canUpdate?: boolean;
};

type CategoryActionOption = {
  id: string;
  label: string;
  logoUrl?: string | undefined;
  integration?: string | undefined;
};

function OptionLogo({
  logoUrl,
  label,
  fallback,
}: {
  logoUrl?: string | undefined;
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
      className="size-4 rounded-sm object-contain"
      height={16}
      loading="lazy"
      src={normalizedLogoUrl}
      width={16}
    />
  );
}

/**
 * The values the rules of the Condition `nodeId` can compare: what the nodes
 * above it produce. A null id has none.
 */
export function useUpstreamConditionFields(
  nodeId: string | null
): ConditionSelectableField[] {
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const catalog = useExtensionCatalog();
  return useMemo(
    () =>
      nodeId === null
        ? []
        : getUpstreamConditionFields({
            currentNodeId: nodeId,
            nodes,
            edges,
            catalog,
          }),
    [nodeId, nodes, edges, catalog]
  );
}

/**
 * The rule builder of the Condition `nodeId`, over `fields`, the values
 * `useUpstreamConditionFields` answers for it. `defaultEditing` opens the
 * builder's controls on mount.
 *
 * The model and the CEL it compiles to are both stored, because the save path
 * checks one against the other before a run is allowed to read either.
 */
export function ConditionFields({
  nodeId,
  fields,
  config,
  onUpdateConfig,
  disabled,
  defaultEditing,
}: {
  nodeId: string;
  fields: ConditionSelectableField[];
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled: boolean;
  defaultEditing?: boolean | undefined;
}) {
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
    <ConditionBuilderRow
      currentNodeId={nodeId}
      defaultEditing={defaultEditing}
      description="Build a condition from Entity fields, the arriving Event, and results from earlier steps. Timestamp fields support relative and absolute time filters."
      disabled={disabled}
      emptyFieldsMessage="No fields are available. Track an Entity or connect this step after the Lifecycle or a step with typed results."
      // The heading is a clause, so the Edit and Done buttons name the thing
      // instead: "Edit Continue when" is not a sentence anybody would say.
      editActionName="condition"
      fields={fields}
      // Named for what it does rather than for the node it sits on: "Condition"
      // on a node called Condition said nothing about which way True leads.
      label="Continue when"
      onChange={handleChange}
      // The one condition row mounted straight into the panel's column, so its
      // header is the one that may pin while the rules below it scroll.
      stickyHeader
      value={readConfigString(config, "conditionModel") ?? ""}
    />
  );
}

/** The rule builder of the selected node, which the panel shows for a Condition. */
function SelectedConditionFields(input: {
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled: boolean;
}) {
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const fields = useUpstreamConditionFields(selectedNodeId);
  return selectedNodeId === null ? null : (
    <ConditionFields {...input} fields={fields} nodeId={selectedNodeId} />
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
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <p className="font-medium text-sm">{EVENT_SPLIT_HEADING}</p>

      {outlets.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {EVENT_SPLIT_NO_SOURCE_TEXT}
        </p>
      ) : (
        <>
          <ul className="space-y-1">
            {outlets.map((event) => (
              <li className="space-y-0.5" key={event.name}>
                <p className="text-sm">{event.label}</p>
                {event.description ? (
                  <p className="text-muted-foreground text-xs">
                    {event.description}
                  </p>
                ) : null}
                <p className="font-mono text-muted-foreground text-xs">
                  {event.name}
                </p>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">
            A run leaves by the outlet naming the Event it arrived on. An outlet
            with nothing connected ends the run there.
          </p>
        </>
      )}
    </div>
  );
}

type WaitFieldProps = {
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled: boolean;
};

function WaitFieldLabel({
  children,
  htmlFor,
  id,
  label,
}: {
  children: ReactNode;
  htmlFor: string;
  id?: string | undefined;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <Label htmlFor={htmlFor} id={id}>
        {label}
      </Label>
      <ConfigHelp label={label}>{children}</ConfigHelp>
    </div>
  );
}

function DelayWaitFields({ config, onUpdateConfig, disabled }: WaitFieldProps) {
  const waitGateMode = readConfigStringOr(config, "waitGateMode", "off");
  const configuredWaitUntil = readConfigString(config, "waitUntil");
  const configuredWaitDuration = readConfigString(config, "waitDuration");
  const configuredWaitMaxLateness = readConfigString(config, "waitMaxLateness");
  const delayTimingMode = readWaitDelayTiming(config);
  const waitGateHelp =
    WAIT_GATE_OPTIONS.find((option) => option.value === waitGateMode)
      ?.description ?? WAIT_GATE_OPTIONS[0].description;
  const allowedHoursMode = readConfigStringOr(
    config,
    "waitAllowedHoursMode",
    "off"
  );
  const isWindowEnabled = allowedHoursMode === "daily_window";

  // Switching timing drops the fields the timing being left owned, so a run
  // never reads a stale duration next to a freshly chosen target date.
  const handleDelayTimingModeChange = (value: string) => {
    const next = { ...config, waitDelayTimingMode: value };
    const cleared = Object.fromEntries(
      waitValueKeysNotIn(next).map((key) => [key, ""])
    );

    onUpdateConfig({ ...cleared, waitDelayTimingMode: value });
  };

  const handleGateModeChange = (value: string) => {
    const next = { ...config, waitGateMode: value };
    const cleared = Object.fromEntries(
      waitValueKeysNotIn(next).map((key) => [key, ""])
    );

    onUpdateConfig({ ...cleared, waitGateMode: value });
  };

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center gap-1">
        <p className="font-medium text-sm">Time-based wait</p>
        <ConfigHelp label="Time-based waits">
          Choose how this step gets its scheduled time. Changing the Time source
          clears settings used only by the previous source.
        </ConfigHelp>
      </div>

      <div className="space-y-2">
        <WaitFieldLabel
          htmlFor="waitDelayTimingMode"
          label={WAIT_FIELD_LABELS.waitDelayTimingMode}
        >
          Choose a duration from when the run reaches this step, or a specific
          date and time.
        </WaitFieldLabel>
        <Select
          disabled={disabled}
          items={WAIT_DELAY_TIMING_OPTIONS}
          onValueChange={whenChosen(handleDelayTimingModeChange)}
          value={delayTimingMode}
        >
          <SelectTrigger className="w-full" id="waitDelayTimingMode">
            <SelectValue placeholder="Choose a time source" />
          </SelectTrigger>
          <SelectContent>
            {WAIT_DELAY_TIMING_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {delayTimingMode === "duration" ? (
        <div className="space-y-2">
          <WaitFieldLabel
            htmlFor="waitDuration"
            label={WAIT_FIELD_LABELS.waitDuration}
          >
            Enter 24h, 90m, milliseconds, or an ISO 8601 duration such as P1D.
            Counting starts when the run reaches this step.
          </WaitFieldLabel>
          <TemplateBadgeInput
            disabled={disabled}
            fieldType={WAIT_VALUE_TARGETS.waitDuration.type}
            id="waitDuration"
            onChange={(value) => onUpdateConfig({ waitDuration: value })}
            placeholder="24h, 90m, 3600000, or P1D"
            value={configuredWaitDuration}
          />
        </div>
      ) : (
        <>
          <div className="space-y-2">
            <WaitFieldLabel
              htmlFor="waitUntil"
              label={WAIT_FIELD_LABELS.waitUntil}
            >
              Enter a specific date and time, or choose a value from Event or
              step data. Times without an offset use the selected Timezone.
            </WaitFieldLabel>
            <TemplateBadgeInput
              disabled={disabled}
              fieldType={WAIT_VALUE_TARGETS.waitUntil.type}
              id="waitUntil"
              onChange={(value) => onUpdateConfig({ waitUntil: value })}
              placeholder="2026-03-10T09:00:00-05:00 or {{@lifecycle_1:Lifecycle.appointment.startsAt}}"
              value={configuredWaitUntil}
            />
          </div>

          <div className="space-y-2">
            <WaitFieldLabel
              htmlFor="waitOffset"
              label={WAIT_FIELD_LABELS.waitOffset}
            >
              Move the scheduled time earlier or later. Use values such as -1d,
              6h, or 30m.
            </WaitFieldLabel>
            <TemplateBadgeInput
              disabled={disabled}
              fieldType={WAIT_VALUE_TARGETS.waitOffset.type}
              id="waitOffset"
              onChange={(value) => onUpdateConfig({ waitOffset: value })}
              placeholder="-1d, 6h, 30m"
              value={readConfigString(config, "waitOffset")}
            />
          </div>
        </>
      )}

      <div className="space-y-2">
        <WaitFieldLabel
          htmlFor="waitGateMode"
          label={WAIT_FIELD_LABELS.waitGateMode}
        >
          {waitGateHelp}
        </WaitFieldLabel>
        <Select
          disabled={disabled}
          items={WAIT_GATE_OPTIONS}
          onValueChange={whenChosen(handleGateModeChange)}
          value={waitGateMode}
        >
          <SelectTrigger className="w-full" id="waitGateMode">
            <SelectValue placeholder="Select behavior" />
          </SelectTrigger>
          <SelectContent>
            {WAIT_GATE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {waitGateMode === "max_lateness" ? (
        <div className="space-y-2">
          <WaitFieldLabel
            htmlFor="waitMaxLateness"
            id="waitMaxLateness-label"
            label={WAIT_FIELD_LABELS.waitMaxLateness}
          >
            Enter the maximum delay, such as 30m or 6h. This limit is checked
            before Allowed hours adjust the scheduled time.
          </WaitFieldLabel>
          <TemplateBadgeInput
            disabled={disabled}
            fieldType={WAIT_VALUE_TARGETS.waitMaxLateness.type}
            id="waitMaxLateness"
            labelledBy="waitMaxLateness-label"
            onChange={(value) => onUpdateConfig({ waitMaxLateness: value })}
            placeholder="30m, 6h, or P1D"
            value={configuredWaitMaxLateness}
          />
        </div>
      ) : null}

      <div className="space-y-2">
        <WaitFieldLabel
          htmlFor="waitAllowedHoursMode"
          label={WAIT_FIELD_LABELS.waitAllowedHoursMode}
        >
          {isWindowEnabled
            ? "A time outside the set hours moves to the next Start time. Use 24-hour times, with Start time before End time."
            : "Any time adds no time-of-day restriction."}
        </WaitFieldLabel>
        <Select
          disabled={disabled}
          items={WAIT_WINDOW_OPTIONS}
          onValueChange={(value) =>
            onUpdateConfig({ waitAllowedHoursMode: value })
          }
          value={allowedHoursMode}
        >
          <SelectTrigger className="w-full" id="waitAllowedHoursMode">
            <SelectValue placeholder="Choose allowed hours" />
          </SelectTrigger>
          <SelectContent>
            {WAIT_WINDOW_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isWindowEnabled && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-2">
            <Label htmlFor="waitAllowedStartTime">
              {WAIT_FIELD_LABELS.waitAllowedStartTime}
            </Label>
            <Input
              disabled={disabled}
              id="waitAllowedStartTime"
              onChange={(e) =>
                onUpdateConfig({ waitAllowedStartTime: e.target.value })
              }
              placeholder="09:00"
              value={readConfigString(config, "waitAllowedStartTime")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="waitAllowedEndTime">
              {WAIT_FIELD_LABELS.waitAllowedEndTime}
            </Label>
            <Input
              disabled={disabled}
              id="waitAllowedEndTime"
              onChange={(e) =>
                onUpdateConfig({ waitAllowedEndTime: e.target.value })
              }
              placeholder="17:00"
              value={readConfigString(config, "waitAllowedEndTime")}
            />
          </div>
        </div>
      )}

      <div className="space-y-2">
        <WaitFieldLabel
          htmlFor="waitTimezone"
          label={`${WAIT_FIELD_LABELS.waitTimezone}${
            isWindowEnabled ? " (required for allowed hours)" : " (optional)"
          }`}
        >
          Sets the clock for Allowed hours and for dates and times without an
          offset.
        </WaitFieldLabel>
        <TimezoneSelect
          disabled={disabled}
          id="waitTimezone"
          onValueChange={(value) => onUpdateConfig({ waitTimezone: value })}
          value={readConfigStringOr(config, "waitTimezone", "UTC")}
        />
      </div>
    </div>
  );
}

function EventWaitFields({ config, onUpdateConfig, disabled }: WaitFieldProps) {
  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center gap-1">
        <p className="font-medium text-sm">Wait for Event</p>
        <ConfigHelp label="Waiting for Events">
          <p>
            The run resumes when a selected Event arrives. With no match, any
            arrival of that Event resumes the run. Add a match to limit which
            Event data qualifies.
          </p>
          <p>
            A timeout is required so the run cannot wait forever. When time runs
            out, continue to the next step or end this branch.
          </p>
        </ConfigHelp>
      </div>
      <WaitEventSelect
        config={config}
        disabled={disabled}
        onUpdateConfig={onUpdateConfig}
      />

      <div className="space-y-2">
        <Label htmlFor="waitTimeout">{WAIT_FIELD_LABELS.waitTimeout}</Label>
        <TemplateBadgeInput
          disabled={disabled}
          fieldType={WAIT_VALUE_TARGETS.waitTimeout.type}
          id="waitTimeout"
          onChange={(value) => onUpdateConfig({ waitTimeout: value })}
          placeholder={DEFAULT_WAIT_TIMEOUT}
          value={readConfigString(config, "waitTimeout")}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="waitTimeoutBehavior">
          {WAIT_FIELD_LABELS.waitTimeoutBehavior}
        </Label>
        <Select
          disabled={disabled}
          items={WAIT_TIMEOUT_OPTIONS}
          onValueChange={(value) =>
            onUpdateConfig({ waitTimeoutBehavior: value })
          }
          value={readConfigStringOr(config, "waitTimeoutBehavior", "continue")}
        >
          <SelectTrigger className="w-full" id="waitTimeoutBehavior">
            <SelectValue placeholder="Select timeout behavior" />
          </SelectTrigger>
          <SelectContent>
            {WAIT_TIMEOUT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
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

    // The default timeout is spread over `cleared` rather than merged into the
    // same literal: `omitUndefined` would otherwise delete the `waitTimeout: ""`
    // that `cleared` carries whenever the node is leaving event mode.
    onUpdateConfig({
      ...cleared,
      waitMode: value,
      ...omitUndefined({
        waitTimeout:
          value === "event" &&
          isBlank(readConfigString(config, "waitTimeout") ?? "")
            ? DEFAULT_WAIT_TIMEOUT
            : undefined,
      }),
    });
  };

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="waitMode">{WAIT_FIELD_LABELS.waitMode}</Label>
        <Select
          disabled={disabled}
          items={WAIT_MODE_OPTIONS}
          onValueChange={whenChosen(handleModeChange)}
          value={waitMode}
        >
          <SelectTrigger className="w-full" id="waitMode">
            <SelectValue placeholder="Select wait mode" />
          </SelectTrigger>
          <SelectContent>
            {WAIT_MODE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

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
        <SelectedConditionFields
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

    return mapValues(grouped, (actions) =>
      actions.map((action) => ({
        id: action.id,
        label: action.label,
        logoUrl: action.logoUrl,
        integration: action.integration,
      }))
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
  canUpdate = true,
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
  const categoryItems = [
    { value: "System", label: "System" },
    ...categoryOptions.map((value) => ({ value, label: value })),
  ];
  const actionOptions = category ? (categories[category] ?? []) : [];
  const actionItems = actionOptions.map((action) => ({
    value: action.id,
    label: action.label,
  }));
  const { data: globalIntegrations = [] } = useQuery({
    ...integrationsQueryOptions(),
    enabled: can(WfGraphOperations.integrationGetAll.id),
  });
  // What the Connection this node names holds for the keys its fields fall back
  // to. Read here rather than in the renderer, because the list is already in
  // hand for the picker below.
  const connectionDefaults = globalIntegrations.find(
    (entry) => entry.id === settledProviderParameter(config.integrationId)
  )?.connectionDefaults;

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

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          <Label className="ml-1" htmlFor="actionCategory">
            Service
          </Label>
          <Select
            disabled={disabled}
            items={categoryItems}
            onValueChange={whenChosen(handleCategoryChange)}
            value={category || undefined}
          >
            <SelectTrigger className="w-full" id="actionCategory">
              <SelectValue placeholder="Select category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="System">
                <div className="flex items-center gap-2">
                  <Settings className="size-4" />
                  <span>System</span>
                </div>
              </SelectItem>
              {categoryOptions.length > 0 && <SelectSeparator />}
              {categoryOptions.map((categoryName) => {
                const actionsInCategory = categories[categoryName];
                // A category groups the actions that declared it, so the icon comes
                // off one of them. Matching the category name against an
                // integration's label worked only because the two happen to agree.
                const categoryIntegration = actionsInCategory?.[0]?.integration;
                const categoryLogoUrl = actionsInCategory
                  ?.map((action) => action.logoUrl)
                  .find(
                    (value) => typeof value === "string" && !isBlank(value)
                  );

                const fallbackIcon = categoryIntegration ? (
                  <IntegrationIcon
                    className="size-4"
                    integration={categoryIntegration}
                  />
                ) : (
                  <Zap className="size-4" />
                );

                return (
                  <SelectItem key={categoryName} value={categoryName}>
                    <div className="flex items-center gap-2">
                      <OptionLogo
                        fallback={fallbackIcon}
                        label={categoryName}
                        logoUrl={categoryLogoUrl}
                      />
                      <span>{categoryName}</span>
                    </div>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label className="ml-1" htmlFor="actionType">
            Action
          </Label>
          <Select
            disabled={disabled || !category}
            items={actionItems}
            onValueChange={whenChosen(handleActionTypeChange)}
            value={actionType || undefined}
          >
            <SelectTrigger className="w-full" id="actionType">
              <SelectValue placeholder="Select action" />
            </SelectTrigger>
            <SelectContent>
              {category &&
                actionOptions.map((action) => {
                  let fallbackIcon: ReactNode;
                  if (category === "System") {
                    fallbackIcon = <Settings className="size-4" />;
                  } else if (action.integration) {
                    fallbackIcon = (
                      <IntegrationIcon
                        className="size-4"
                        integration={action.integration}
                      />
                    );
                  } else {
                    fallbackIcon = <Zap className="size-4" />;
                  }

                  return (
                    <SelectItem key={action.id} value={action.id}>
                      <div className="flex items-center gap-2">
                        <OptionLogo
                          fallback={fallbackIcon}
                          label={action.label}
                          logoUrl={action.logoUrl}
                        />
                        <span>{action.label}</span>
                      </div>
                    </SelectItem>
                  );
                })}
            </SelectContent>
          </Select>
        </div>
      </div>

      {integrationType && canUpdate && (
        <div className="space-y-2">
          <div className="ml-1 flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Label>Connection</Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex">
                        <HelpCircle className="size-3.5 text-muted-foreground" />
                      </span>
                    }
                  >
                    <span className="sr-only">Connection help</span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>API key or OAuth credentials for this service</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
          <IntegrationSelector
            disabled={disabled}
            integrationType={integrationType}
            onChange={(id) => onUpdateConfig({ integrationId: id })}
            value={readConfigString(config, "integrationId")}
          />
        </div>
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
          connectionDefaults={connectionDefaults}
          disabled={disabled}
          fields={catalogAction.configFields}
          onUpdateConfig={onUpdateConfig}
        />
      )}
    </>
  );
}
