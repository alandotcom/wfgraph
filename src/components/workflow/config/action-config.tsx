import { useAtomValue, useSetAtom } from "jotai";
import { HelpCircle, Plus, Settings, Zap } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  integrationsAtom,
  integrationsVersionAtom,
} from "@/client/lib/integrations-store";
import { ConfigureConnectionOverlay } from "@/components/overlays/add-connection-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import { IntegrationSelector } from "@/components/ui/integration-selector";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { TimezoneSelect } from "@/components/ui/timezone-select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  findActionById,
  getActionsByCategory,
  getAllIntegrations,
} from "@/plugins";
import type { IntegrationType } from "@/shared/types/integration";
import { SYSTEM_ACTION_INTEGRATIONS } from "@/shared/workflow/system-action-integrations";
import { ActionConfigRenderer } from "./action-config-renderer";
import { SchemaBuilder, type SchemaField } from "./schema-builder";

type ActionConfigProps = {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
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

// Database Query fields component
function DatabaseQueryFields({
  config,
  onUpdateConfig,
  disabled,
}: {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="dbQuery">SQL Query</Label>
        <div className="overflow-hidden rounded-md border">
          <CodeEditor
            defaultLanguage="sql"
            height="150px"
            onChange={(value) => onUpdateConfig("dbQuery", value || "")}
            options={{
              minimap: { enabled: false },
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              fontSize: 12,
              readOnly: disabled,
              wordWrap: "off",
            }}
            value={(config?.dbQuery as string) || ""}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          The DATABASE_URL from your project integrations will be used to
          execute this query.
        </p>
      </div>
      <div className="space-y-2">
        <Label>Schema (Optional)</Label>
        <SchemaBuilder
          disabled={disabled}
          onChange={(schema) =>
            onUpdateConfig("dbSchema", JSON.stringify(schema))
          }
          schema={
            config?.dbSchema
              ? (JSON.parse(config.dbSchema as string) as SchemaField[])
              : []
          }
        />
      </div>
    </>
  );
}

// HTTP Request fields component
function HttpRequestFields({
  config,
  onUpdateConfig,
  disabled,
}: {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="httpMethod">HTTP Method</Label>
        <Select
          disabled={disabled}
          onValueChange={(value) => onUpdateConfig("httpMethod", value)}
          value={(config?.httpMethod as string) || "POST"}
        >
          <SelectTrigger className="w-full" id="httpMethod">
            <SelectValue placeholder="Select method" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="GET">GET</SelectItem>
            <SelectItem value="POST">POST</SelectItem>
            <SelectItem value="PUT">PUT</SelectItem>
            <SelectItem value="PATCH">PATCH</SelectItem>
            <SelectItem value="DELETE">DELETE</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="endpoint">URL</Label>
        <TemplateBadgeInput
          disabled={disabled}
          id="endpoint"
          onChange={(value) => onUpdateConfig("endpoint", value)}
          placeholder="https://api.example.com/endpoint or {{NodeName.url}}"
          value={(config?.endpoint as string) || ""}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="httpHeaders">Headers (JSON)</Label>
        <div className="overflow-hidden rounded-md border">
          <CodeEditor
            defaultLanguage="json"
            height="100px"
            onChange={(value) => onUpdateConfig("httpHeaders", value || "{}")}
            options={{
              minimap: { enabled: false },
              lineNumbers: "off",
              scrollBeyondLastLine: false,
              fontSize: 12,
              readOnly: disabled,
              wordWrap: "off",
            }}
            value={(config?.httpHeaders as string) || "{}"}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="httpBody">Body (JSON)</Label>
        <div
          className={`overflow-hidden rounded-md border ${config?.httpMethod === "GET" ? "opacity-50" : ""}`}
        >
          <CodeEditor
            defaultLanguage="json"
            height="120px"
            onChange={(value) => onUpdateConfig("httpBody", value || "{}")}
            options={{
              minimap: { enabled: false },
              lineNumbers: "off",
              scrollBeyondLastLine: false,
              fontSize: 12,
              readOnly: config?.httpMethod === "GET" || disabled,
              domReadOnly: config?.httpMethod === "GET" || disabled,
              wordWrap: "off",
            }}
            value={(config?.httpBody as string) || "{}"}
          />
        </div>
        {config?.httpMethod === "GET" && (
          <p className="text-muted-foreground text-xs">
            Body is disabled for GET requests
          </p>
        )}
      </div>
    </>
  );
}

// Condition fields component
function ConditionFields({
  config,
  onUpdateConfig,
  disabled,
}: {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="condition">Condition Expression</Label>
      <TemplateBadgeInput
        disabled={disabled}
        id="condition"
        onChange={(value) => onUpdateConfig("condition", value)}
        placeholder="e.g., 5 > 3, status === 200, {{PreviousNode.value}} > 100"
        value={(config?.condition as string) || ""}
      />
      <p className="text-muted-foreground text-xs">
        Enter a JavaScript expression that evaluates to true or false. You can
        use @ to reference previous node outputs.
      </p>
    </div>
  );
}

function RunConditionField({
  config,
  onUpdateConfig,
  disabled,
}: {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <Label htmlFor="runCondition">Run this step only when (optional)</Label>
      <TemplateBadgeInput
        disabled={disabled}
        id="runCondition"
        onChange={(value) => onUpdateConfig("runCondition", value)}
        placeholder="{{@trigger:Webhook.data.status}} !== 'cancelled'"
        value={(config?.runCondition as string) || ""}
      />
      <p className="text-muted-foreground text-xs">
        JavaScript expression. When false, this step is skipped and the workflow
        continues to downstream steps.
      </p>
    </div>
  );
}

function RunConditionSection({
  actionType,
  config,
  onUpdateConfig,
  disabled,
}: {
  actionType: string;
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
}) {
  if (!actionType || actionType === "Condition") {
    return null;
  }

  return (
    <RunConditionField
      config={config}
      disabled={disabled}
      onUpdateConfig={onUpdateConfig}
    />
  );
}

type WaitFieldProps = {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
};

function getDelayTimingMode(
  config: Record<string, unknown>
): "duration" | "until" {
  const delayTimingModeRaw = (config.waitDelayTimingMode as string) || "";
  if (delayTimingModeRaw === "duration" || delayTimingModeRaw === "until") {
    return delayTimingModeRaw;
  }

  const waitUntil = (config.waitUntil as string) || "";
  if (waitUntil.trim()) {
    return "until";
  }

  return "duration";
}

function DelayWaitFields({ config, onUpdateConfig, disabled }: WaitFieldProps) {
  const waitGateMode = (config.waitGateMode as string) || "off";
  const configuredWaitUntil = (config.waitUntil as string) || "";
  const configuredWaitDuration = (config.waitDuration as string) || "";
  const delayTimingMode = getDelayTimingMode(config);

  const handleDelayTimingModeChange = (value: string) => {
    onUpdateConfig("waitDelayTimingMode", value);

    if (value === "duration") {
      onUpdateConfig("waitUntil", "");
      onUpdateConfig("waitOffset", "");
      return;
    }

    if (value === "until") {
      onUpdateConfig("waitDuration", "");
    }
  };

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <p className="font-medium text-xs uppercase tracking-wide">
        Time-Based Wait
      </p>

      <div className="space-y-2">
        <Label htmlFor="waitDelayTimingMode">Time input mode</Label>
        <Select
          disabled={disabled}
          onValueChange={handleDelayTimingModeChange}
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
            id="waitDuration"
            onChange={(value) => onUpdateConfig("waitDuration", value)}
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
              id="waitUntil"
              onChange={(value) => onUpdateConfig("waitUntil", value)}
              placeholder="2026-03-10T09:00:00-05:00 or {{Trigger.data.startsAt}}"
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
              id="waitOffset"
              onChange={(value) => onUpdateConfig("waitOffset", value)}
              placeholder="-1d, 6h, 30m"
              value={(config.waitOffset as string) || ""}
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
          onValueChange={(value) => onUpdateConfig("waitGateMode", value)}
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
        <Label htmlFor="waitTimezone">Timezone (optional)</Label>
        <TimezoneSelect
          disabled={disabled}
          id="waitTimezone"
          onValueChange={(value) => onUpdateConfig("waitTimezone", value)}
          value={(config.waitTimezone as string) || "UTC"}
        />
        <p className="text-muted-foreground text-xs">
          Used when the target date/time does not include an offset.
        </p>
      </div>
    </div>
  );
}

function HookWaitFields({ config, onUpdateConfig, disabled }: WaitFieldProps) {
  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <p className="font-medium text-xs uppercase tracking-wide">
        Event-Based Wait
      </p>
      <div className="space-y-2">
        <Label htmlFor="waitForEvents">
          Resume when event is (comma separated)
        </Label>
        <TemplateBadgeInput
          disabled={disabled}
          id="waitForEvents"
          onChange={(value) => onUpdateConfig("waitForEvents", value)}
          placeholder="event.update,event.confirmed"
          value={(config.waitForEvents as string) || ""}
        />
        <p className="text-muted-foreground text-xs">
          Leave empty to resume on any matching event for the same entity.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="waitTimeout">Stop waiting after (optional)</Label>
        <TemplateBadgeInput
          disabled={disabled}
          id="waitTimeout"
          onChange={(value) => onUpdateConfig("waitTimeout", value)}
          placeholder="48h"
          value={(config.waitTimeout as string) || ""}
        />
        <p className="text-muted-foreground text-xs">
          Optional safety timeout if the expected event never arrives.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="waitHookToken">Explicit hook token (optional)</Label>
        <TemplateBadgeInput
          disabled={disabled}
          id="waitHookToken"
          onChange={(value) => onUpdateConfig("waitHookToken", value)}
          placeholder="custom-token-if-you-need-deterministic-resume"
          value={(config.waitHookToken as string) || ""}
        />
        <p className="text-muted-foreground text-xs">
          Leave blank unless an external system must target a fixed token.
        </p>
      </div>
    </div>
  );
}

// Wait fields component
function WaitFields({ config, onUpdateConfig, disabled }: WaitFieldProps) {
  const waitMode = (config.waitMode as string) || "delay";

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="waitMode">How should this step wait?</Label>
        <Select
          disabled={disabled}
          onValueChange={(value) => onUpdateConfig("waitMode", value)}
          value={waitMode}
        >
          <SelectTrigger className="w-full" id="waitMode">
            <SelectValue placeholder="Select wait mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="delay">Wait for time</SelectItem>
            <SelectItem value="hook">Wait for webhook event</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          Choose between time-based waiting or waiting for a follow-up webhook
          event.
        </p>
      </div>

      {waitMode === "delay" && (
        <DelayWaitFields
          config={config}
          disabled={disabled}
          onUpdateConfig={onUpdateConfig}
        />
      )}

      {waitMode === "hook" && (
        <HookWaitFields
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
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
}) {
  switch (actionType) {
    case "HTTP Request":
      return (
        <HttpRequestFields
          config={config}
          disabled={disabled}
          onUpdateConfig={onUpdateConfig}
        />
      );
    case "Database Query":
      return (
        <DatabaseQueryFields
          config={config}
          disabled={disabled}
          onUpdateConfig={onUpdateConfig}
        />
      );
    case "Condition":
      return (
        <ConditionFields
          config={config}
          disabled={disabled}
          onUpdateConfig={onUpdateConfig}
        />
      );
    case "Wait":
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

// System actions that don't have plugins
const SYSTEM_ACTIONS: CategoryActionOption[] = [
  { id: "HTTP Request", label: "HTTP Request" },
  { id: "Database Query", label: "Database Query" },
  { id: "Condition", label: "Condition" },
  { id: "Wait", label: "Wait" },
];

const SYSTEM_ACTION_IDS = SYSTEM_ACTIONS.map((a) => a.id);

// Build category mapping dynamically from plugins + System
function useCategoryData(): Record<string, CategoryActionOption[]> {
  return useMemo(() => {
    const pluginCategories = getActionsByCategory();

    // Build category map including System with both id and label
    const allCategories: Record<string, CategoryActionOption[]> = {
      System: SYSTEM_ACTIONS,
    };

    for (const [category, actions] of Object.entries(pluginCategories)) {
      allCategories[category] = actions.map((a) => ({
        id: a.id,
        label: a.label,
        logoUrl: a.logoUrl,
        integration:
          typeof a.integration === "string" ? a.integration : undefined,
      }));
    }

    return allCategories;
  }, []);
}

// Get category for an action type (supports both new IDs, labels, and legacy labels)
function getCategoryForAction(actionType: string): string | null {
  // Check system actions first
  if (SYSTEM_ACTION_IDS.includes(actionType)) {
    return "System";
  }

  // Use findActionById which handles legacy labels from plugin registry
  const action = findActionById(actionType);
  if (action?.category) {
    return action.category;
  }

  return null;
}

// Normalize action type to new ID format (handles legacy labels via findActionById)
function normalizeActionType(actionType: string): string {
  // Check system actions first - they use their label as ID
  if (SYSTEM_ACTION_IDS.includes(actionType)) {
    return actionType;
  }

  // Use findActionById which handles legacy labels and returns the proper ID
  const action = findActionById(actionType);
  if (action) {
    return action.id;
  }

  return actionType;
}

export function ActionConfig({
  config,
  onUpdateConfig,
  disabled,
  isOwner = true,
}: ActionConfigProps) {
  const actionType = (config?.actionType as string) || "";
  const categories = useCategoryData();
  const integrations = useMemo(() => getAllIntegrations(), []);
  const integrationByLabel = useMemo(
    () =>
      new Map(
        integrations.map((integration) => [integration.label, integration])
      ),
    [integrations]
  );
  const categoryOptions = useMemo(
    () =>
      Object.keys(categories)
        .filter((name) => name !== "System")
        .sort(),
    [categories]
  );

  const selectedCategory = actionType ? getCategoryForAction(actionType) : null;
  const [category, setCategory] = useState<string>(selectedCategory || "");
  const setIntegrationsVersion = useSetAtom(integrationsVersionAtom);
  const globalIntegrations = useAtomValue(integrationsAtom);
  const { push } = useOverlay();

  // Sync category state when actionType changes (e.g., when switching nodes)
  useEffect(() => {
    const newCategory = actionType ? getCategoryForAction(actionType) : null;
    setCategory(newCategory || "");
  }, [actionType]);

  const handleCategoryChange = (newCategory: string) => {
    setCategory(newCategory);
    // Auto-select the first action in the new category
    const firstAction = categories[newCategory]?.[0];
    if (firstAction) {
      onUpdateConfig("actionType", firstAction.id);
    }
  };

  const handleActionTypeChange = (value: string) => {
    onUpdateConfig("actionType", value);
  };

  // Adapter for plugin config components that expect (key, value: unknown)
  const handlePluginUpdateConfig = (key: string, value: unknown) => {
    onUpdateConfig(key, String(value));
  };

  // Get dynamic config fields for plugin actions
  const pluginAction = actionType ? findActionById(actionType) : null;

  // Determine the integration type for the current action
  const integrationType: IntegrationType | undefined = useMemo(() => {
    if (!actionType) {
      return;
    }

    // Check system actions first
    if (SYSTEM_ACTION_INTEGRATIONS[actionType]) {
      return SYSTEM_ACTION_INTEGRATIONS[actionType];
    }

    // Check plugin actions
    const action = findActionById(actionType);
    return action?.integration as IntegrationType | undefined;
  }, [actionType]);

  // Check if there are existing connections for this integration type
  const hasExistingConnections = useMemo(() => {
    if (!integrationType) {
      return false;
    }
    return globalIntegrations.some((i) => i.type === integrationType);
  }, [integrationType, globalIntegrations]);

  const openConnectionOverlay = () => {
    if (integrationType) {
      push(ConfigureConnectionOverlay, {
        type: integrationType,
        onSuccess: (integrationId: string) => {
          setIntegrationsVersion((v) => v + 1);
          onUpdateConfig("integrationId", integrationId);
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
            onValueChange={handleCategoryChange}
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
                const integration = integrationByLabel.get(categoryName);
                const categoryLogoUrl = categories[categoryName]
                  ?.map((action) => action.logoUrl)
                  .find(
                    (value) =>
                      typeof value === "string" && value.trim().length > 0
                  );

                const fallbackIcon = integration ? (
                  <IntegrationIcon
                    className="size-4"
                    integration={integration.type}
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
            onValueChange={handleActionTypeChange}
            value={normalizeActionType(actionType) || undefined}
          >
            <SelectTrigger className="w-full" id="actionType">
              <SelectValue placeholder="Select action" />
            </SelectTrigger>
            <SelectContent>
              {category &&
                categories[category]?.map((action) => {
                  const integrationType =
                    typeof action.integration === "string"
                      ? action.integration
                      : undefined;
                  const integration = integrationType
                    ? integrations.find((item) => item.type === integrationType)
                    : undefined;
                  let fallbackIcon: ReactNode;
                  if (category === "System") {
                    fallbackIcon = <Settings className="size-4" />;
                  } else if (integration) {
                    fallbackIcon = (
                      <IntegrationIcon
                        className="size-4"
                        integration={integration.type}
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
            onChange={(id) => onUpdateConfig("integrationId", id)}
            value={(config?.integrationId as string) || ""}
          />
        </div>
      )}

      {/* System actions - hardcoded config fields */}
      <SystemActionFields
        actionType={(config?.actionType as string) || ""}
        config={config}
        disabled={disabled}
        onUpdateConfig={onUpdateConfig}
      />

      {/* Plugin actions - declarative config fields */}
      {pluginAction && !SYSTEM_ACTION_IDS.includes(actionType) && (
        <ActionConfigRenderer
          config={config}
          disabled={disabled}
          fields={pluginAction.configFields}
          onUpdateConfig={handlePluginUpdateConfig}
        />
      )}

      <RunConditionSection
        actionType={actionType}
        config={config}
        disabled={disabled}
        onUpdateConfig={onUpdateConfig}
      />
    </>
  );
}
