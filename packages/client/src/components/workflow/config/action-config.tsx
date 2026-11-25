import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { ChevronRight, HelpCircle } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#src/components/ui/collapsible";
import { isBlank } from "@wfgraph/shared/types/string";
import { Input } from "#src/components/ui/input";
import { IntegrationSelector } from "#src/components/ui/integration-selector";
import { Label } from "#src/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
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
import { findAction } from "@wfgraph/shared/extensions/catalog";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { waitDurationCannotBeRead } from "@wfgraph/shared/actions/action-config-validation";
import { parseDurationMs } from "@wfgraph/shared/utils/wait-time";
import { waitDurationReadback } from "#src/lib/duration-words";
import { Button } from "#src/components/ui/button";
import { cn } from "@wfgraph/shared/utils";
import { ButtonGroup } from "#src/components/ui/button-group";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  DEFAULT_WAIT_TIMEOUT,
  readWaitDelayTiming,
  WAIT_VALUE_TARGETS,
  waitValueKeysNotIn,
} from "@wfgraph/shared/lifecycle/wait-subscription";
import { ActionConfigRenderer } from "./action-config-renderer";
import type { ConfigOptionsOwner } from "#src/lib/config-options-query";
import { ConditionBuilderRow } from "./condition-builder-row";
import { ConfigHelp } from "./config-section";
import { FieldIssueMessages } from "./field-issues";
import type { UpdateNodeConfig } from "./node-config-patch";
import { WaitEventSelect } from "./wait-event-select";
import {
  COMMON_WAIT_DURATIONS,
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
  ACTION_TYPE_CONFIG_KEY,
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

function configOptionsOwner(
  action: { id: string; integration?: string | undefined },
  config: Record<string, unknown>
): ConfigOptionsOwner {
  return action.integration
    ? {
        kind: "integration",
        integrationId: settledProviderParameter(config.integrationId),
      }
    : { kind: "action", actionId: action.id };
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
 * `useUpstreamConditionFields` answers for it.
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
}: {
  nodeId: string;
  fields: ConditionSelectableField[];
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled: boolean;
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
      description="Build a condition from Entity fields, the arriving Event, and results from earlier steps. Timestamp fields support relative and absolute time filters."
      disabled={disabled}
      emptyFieldsMessage="No fields are available. Track an Entity or connect this step after the start or a step with typed results."
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

/**
 * "More options" over the settings a Wait rarely needs. Closed until one of
 * them is set (`set`), and then open; a press opens or closes it for as long
 * as the form shows.
 */
function MoreOptions({ set, children }: { set: boolean; children: ReactNode }) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? set;
  return (
    <Collapsible onOpenChange={setChosen} open={open}>
      <CollapsibleTrigger className="flex items-center gap-1 rounded-sm text-muted-foreground text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 transition-transform duration-150",
            open && "rotate-90"
          )}
        />
        More options
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-3">
        {children}
      </CollapsibleContent>
    </Collapsible>
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
    <>
      <div className="flex items-center gap-1">
        <Label htmlFor={htmlFor} id={id}>
          {label}
        </Label>
        <ConfigHelp label={label}>{children}</ConfigHelp>
      </div>
      <FieldIssueMessages fieldKey={htmlFor} />
    </>
  );
}

/**
 * How long a duration Wait waits: the common lengths as one-press choices,
 * a field for any other length or a value from Event or step data, and a line
 * reading the typed value back in words. A choice is pressed whenever the
 * field holds the same length in any notation, so "24h" presses "1 day".
 */
function WaitDurationField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const unreadable = waitDurationCannotBeRead(value);
  const readback = unreadable
    ? "This step cannot read that length. Type it as 1d, 24h or 90m."
    : waitDurationReadback(value);
  const typedMs = parseDurationMs(value);

  return (
    <div className="space-y-2">
      <WaitFieldLabel
        htmlFor="waitDuration"
        id="waitDuration-label"
        label={WAIT_FIELD_LABELS.waitDuration}
      >
        <p>Counting starts when the run reaches this step.</p>
        <p>
          A typed length can be 24h, 90m, milliseconds, or an ISO 8601 duration
          such as P1D.
        </p>
        <p>Type @ to use a length from the Event or an earlier step.</p>
      </WaitFieldLabel>
      <ButtonGroup
        aria-label="Common durations"
        className="w-full rounded-md bg-muted p-0.5"
      >
        {COMMON_WAIT_DURATIONS.map((choice) => {
          const pressed =
            typedMs !== null && typedMs === parseDurationMs(choice.value);
          return (
            <Button
              aria-pressed={pressed}
              className="h-6 flex-1 border-0 px-2 shadow-none"
              disabled={disabled}
              key={choice.value}
              onClick={() => onChange(choice.value)}
              size="sm"
              type="button"
              variant={pressed ? "default" : "ghost"}
            >
              {choice.label}
            </Button>
          );
        })}
      </ButtonGroup>
      <TemplateBadgeInput
        describedBy={readback === null ? undefined : "waitDuration-readback"}
        disabled={disabled}
        fieldType={WAIT_VALUE_TARGETS.waitDuration.type}
        id="waitDuration"
        invalid={unreadable}
        labelledBy="waitDuration-label"
        onChange={onChange}
        placeholder="Or type a length, such as 90m or 2d"
        value={value}
      />
      {readback === null ? null : (
        <p
          className={cn(
            "text-xs",
            unreadable ? "text-destructive" : "text-muted-foreground"
          )}
          id="waitDuration-readback"
        >
          {readback}
        </p>
      )}
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
  // Each option a delay Wait rarely needs, set away from its default.
  const timezone = readConfigString(config, "waitTimezone") ?? "";
  const optionsSet =
    delayTimingMode !== "duration" ||
    waitGateMode !== "off" ||
    allowedHoursMode !== "off" ||
    (!isBlank(timezone) && timezone !== "UTC");

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

      {delayTimingMode === "duration" ? (
        <WaitDurationField
          disabled={disabled}
          onChange={(value) => onUpdateConfig({ waitDuration: value })}
          value={configuredWaitDuration ?? ""}
        />
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

      <MoreOptions set={optionsSet}>
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
      </MoreOptions>
    </div>
  );
}

function EventWaitFields({ config, onUpdateConfig, disabled }: WaitFieldProps) {
  // The timeout and what happens at it, set away from the defaults Event
  // mode writes. A blank timeout is unset, which Publish refuses, so it opens.
  const optionsSet =
    readConfigString(config, "waitTimeout") !== DEFAULT_WAIT_TIMEOUT ||
    readConfigStringOr(config, "waitTimeoutBehavior", "continue") !==
      "continue";
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

      <MoreOptions set={optionsSet}>
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
          <FieldIssueMessages fieldKey="waitTimeout" />
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
            value={readConfigStringOr(
              config,
              "waitTimeoutBehavior",
              "continue"
            )}
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
      </MoreOptions>
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

export function ActionConfig({
  config,
  onUpdateConfig,
  disabled,
  canUpdate = true,
}: ActionConfigProps) {
  const catalog = useExtensionCatalog();
  const actionType = readConfigString(config, ACTION_TYPE_CONFIG_KEY);
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

  const catalogAction = actionType
    ? findAction(catalog, actionType)
    : undefined;

  // Which connection this action needs, which the catalog answers for every
  // action alike.
  const integrationType = catalogAction?.integration;

  return (
    <>
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
          <FieldIssueMessages fieldKey="integrationId" />
        </div>
      )}

      {/* System actions - hardcoded config fields */}
      <SystemActionFields
        actionType={readConfigString(config, ACTION_TYPE_CONFIG_KEY) ?? ""}
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
          owner={configOptionsOwner(catalogAction, config)}
        />
      )}
    </>
  );
}
