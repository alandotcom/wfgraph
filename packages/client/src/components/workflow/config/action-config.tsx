import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { HelpCircle, Plus, Settings, Zap } from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";
import { ConfigureConnectionOverlay } from "#src/components/overlays/add-connection-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { Button } from "#src/components/ui/button";
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
  whenChosen,
} from "#src/components/ui/select";
import { TemplateBadgeInput } from "#src/components/ui/template-badge-input";
import { TimezoneSelect } from "#src/components/ui/timezone-select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#src/components/ui/tooltip";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { useEventSplitOutlets } from "#src/lib/event-split-outlets";
import { getUpstreamConditionFields } from "#src/lib/upstream-node-fields";
import {
  edgesAtom,
  nodesAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import {
  actionsByCategory,
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
      className="size-4 rounded-sm object-contain"
      height={16}
      loading="lazy"
      src={normalizedLogoUrl}
      width={16}
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
      <p className="font-medium text-sm">Splits On Event</p>

      {outlets.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No Event reaches this node yet. Connect it below the Lifecycle Node,
          and it draws one outlet per Start Event.
        </p>
      ) : (
        <>
          <ul className="space-y-1">
            {outlets.map((event) => (
              <li className="text-sm" key={event.name}>
                {event.label}
                <span className="ml-2 text-muted-foreground text-xs">
                  {event.name}
                </span>
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
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <p className="font-medium text-sm">Time-Based Wait</p>

      <div className="space-y-2">
        <Label htmlFor="waitDelayTimingMode">Time input mode</Label>
        <Select
          disabled={disabled}
          onValueChange={whenChosen(handleDelayTimingModeChange)}
          value={delayTimingMode}
        >
          <SelectTrigger className="w-full" id="waitDelayTimingMode">
            <SelectValue placeholder="Select time input mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="duration">Wait for duration</SelectItem>
            <SelectItem value="until">Wait until date/time</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          Pick one mode. Switching modes clears fields that do not apply.
        </p>
      </div>

      {delayTimingMode === "duration" ? (
        <div className="space-y-2">
          <Label htmlFor="waitDuration">Wait for (duration)</Label>
          <TemplateBadgeInput
            disabled={disabled}
            fieldType={WAIT_VALUE_TARGETS.waitDuration.type}
            id="waitDuration"
            onChange={(value) => onUpdateConfig({ waitDuration: value })}
            placeholder="24h, 90m, 3600000, or P1D"
            value={configuredWaitDuration}
          />
          <p className="text-muted-foreground text-xs">
            Example: use <code>24h</code> to continue one day later.
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor="waitUntil">Wait until this date/time</Label>
            <TemplateBadgeInput
              disabled={disabled}
              fieldType={WAIT_VALUE_TARGETS.waitUntil.type}
              id="waitUntil"
              onChange={(value) => onUpdateConfig({ waitUntil: value })}
              placeholder="2026-03-10T09:00:00-05:00 or {{@lifecycle_1:Lifecycle.appointment.startsAt}}"
              value={configuredWaitUntil}
            />
            <p className="text-muted-foreground text-xs">
              Use this when timing comes from payload data, like an appointment
              start time.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="waitOffset">
              Send before/after that time (optional)
            </Label>
            <TemplateBadgeInput
              disabled={disabled}
              fieldType={WAIT_VALUE_TARGETS.waitOffset.type}
              id="waitOffset"
              onChange={(value) => onUpdateConfig({ waitOffset: value })}
              placeholder="-1d, 6h, 30m"
              value={readConfigString(config, "waitOffset")}
            />
            <p className="text-muted-foreground text-xs">
              Example: <code>-1d</code> sends one day before the target time.
            </p>
          </div>
        </>
      )}

      <div className="space-y-2">
        <Label htmlFor="waitGateMode">
          Continue only if time actually elapsed
        </Label>
        <Select
          disabled={disabled}
          onValueChange={(value) => onUpdateConfig({ waitGateMode: value })}
          value={waitGateMode}
        >
          <SelectTrigger className="w-full" id="waitGateMode">
            <SelectValue placeholder="Select behavior" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">Off (continue immediately)</SelectItem>
            <SelectItem value="require_actual_wait">
              Skip branch when already due
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          Prevents immediate sends when the computed time is now or in the past
          after an update/reschedule.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="waitAllowedHoursMode">Allowed send window</Label>
        <Select
          disabled={disabled}
          onValueChange={(value) =>
            onUpdateConfig({ waitAllowedHoursMode: value })
          }
          value={readConfigStringOr(config, "waitAllowedHoursMode", "off")}
        >
          <SelectTrigger className="w-full" id="waitAllowedHoursMode">
            <SelectValue placeholder="Select window mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">Off (allow any time)</SelectItem>
            <SelectItem value="daily_window">Daily window</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          When enabled, times outside the window shift to the next allowed
          start.
        </p>
      </div>

      {isWindowEnabled && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-2">
            <Label htmlFor="waitAllowedStartTime">Window start</Label>
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
            <Label htmlFor="waitAllowedEndTime">Window end</Label>
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
          <p className="col-span-2 text-muted-foreground text-xs">
            Use 24-hour format (HH:MM). Start must be before end. Requires
            timezone below.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="waitTimezone">
          Timezone
          {isWindowEnabled ? " (required for send window)" : " (optional)"}
        </Label>
        <TimezoneSelect
          disabled={disabled}
          id="waitTimezone"
          onValueChange={(value) => onUpdateConfig({ waitTimezone: value })}
          value={readConfigStringOr(config, "waitTimezone", "UTC")}
        />
        <p className="text-muted-foreground text-xs">
          Used when the target date/time does not include an offset.
          {isWindowEnabled &&
            " Also determines when the daily send window applies."}
        </p>
      </div>
    </div>
  );
}

function EventWaitFields({ config, onUpdateConfig, disabled }: WaitFieldProps) {
  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <p className="font-medium text-sm">Wait for Event</p>
      <WaitEventSelect
        config={config}
        disabled={disabled}
        onUpdateConfig={onUpdateConfig}
      />

      <div className="space-y-2">
        <Label htmlFor="waitTimeout">Stop waiting after</Label>
        <TemplateBadgeInput
          disabled={disabled}
          fieldType={WAIT_VALUE_TARGETS.waitTimeout.type}
          id="waitTimeout"
          onChange={(value) => onUpdateConfig({ waitTimeout: value })}
          placeholder={DEFAULT_WAIT_TIMEOUT}
          value={readConfigString(config, "waitTimeout")}
        />
        <p className="text-muted-foreground text-xs">
          Required. A wait with no end holds a run, and a place in the run list,
          until somebody notices.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="waitTimeoutBehavior">On timeout</Label>
        <Select
          disabled={disabled}
          onValueChange={(value) =>
            onUpdateConfig({ waitTimeoutBehavior: value })
          }
          value={readConfigStringOr(config, "waitTimeoutBehavior", "continue")}
        >
          <SelectTrigger className="w-full" id="waitTimeoutBehavior">
            <SelectValue placeholder="Select timeout behavior" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="continue">Continue workflow</SelectItem>
            <SelectItem value="skip">Skip remaining branch</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          Choose whether to continue downstream nodes or halt the branch when
          the timeout expires.
        </p>
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
      <div className="space-y-2">
        <Label htmlFor="waitMode">How should this step wait?</Label>
        <Select
          disabled={disabled}
          onValueChange={whenChosen(handleModeChange)}
          value={waitMode}
        >
          <SelectTrigger className="w-full" id="waitMode">
            <SelectValue placeholder="Select wait mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="delay">Wait for time</SelectItem>
            <SelectItem value="event">Wait for an event</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          Resume on a clock, or when an event arrives that this step's match
          accepts.
        </p>
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
function useCategoryData(): Record<string, CategoryActionOption[]> {
  const catalog = useExtensionCatalog();
  return useMemo(() => {
    const grouped = actionsByCategory(catalog);

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
  }, [catalog]);
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
  const categories = useCategoryData();
  const categoryOptions = useMemo(
    () =>
      Object.keys(categories)
        .filter((name) => name !== "System")
        .sort(),
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
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          <Label className="ml-1" htmlFor="actionCategory">
            Service
          </Label>
          <Select
            disabled={disabled}
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
                    (value) =>
                      typeof value === "string" && value.trim().length > 0
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
            onValueChange={whenChosen(handleActionTypeChange)}
            value={actionType || undefined}
          >
            <SelectTrigger className="w-full" id="actionType">
              <SelectValue placeholder="Select action" />
            </SelectTrigger>
            <SelectContent>
              {category &&
                categories[category]?.map((action) => {
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

      {integrationType && isOwner && (
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
            {hasExistingConnections && (
              <Button
                aria-label="Add connection"
                className="size-6"
                disabled={disabled}
                onClick={openConnectionOverlay}
                size="icon"
                variant="ghost"
              >
                <Plus className="size-4" />
              </Button>
            )}
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
          disabled={disabled}
          fields={catalogAction.configFields}
          onUpdateConfig={onUpdateConfig}
        />
      )}
    </>
  );
}
