import { useAtomValue, useSetAtom } from "jotai";
import { HelpCircle, Plus, Settings, Zap } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  type IntegrationType,
  isIntegrationType,
} from "@/shared/types/integration";
import {
  parseWorkflowSchemaFieldsOrJsonSchema,
  parseWorkflowSchemaFieldsString,
  workflowSchemaFieldsToJsonSchemaDocument,
} from "@/shared/workflow/schema-codec";
import { SYSTEM_ACTION_INTEGRATIONS } from "@/shared/workflow/system-action-integrations";
import { ActionConfigRenderer } from "./action-config-renderer";
import { ConditionBuilderRow } from "./condition-builder-row";
import { SchemaBuilder } from "./schema-builder";

type ActionConfigProps = {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: unknown) => void;
  disabled: boolean;
  isOwner?: boolean;
};

type CategoryActionOption = {
  id: string;
  label: string;
  logoUrl?: string;
  integration?: string;
};

type SchemaEditorMode = "builder" | "json";

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string,
  fallback = ""
): string {
  const value = config?.[key];
  return typeof value === "string" ? value : fallback;
}

function isSchemaEditorMode(value: string): value is SchemaEditorMode {
  return value === "builder" || value === "json";
}

function readOutputSchema(
  config: Record<string, unknown>,
  key: "dbOutputSchema" | "httpOutputSchema"
): string {
  const schema = config[key];
  return typeof schema === "string" ? schema : "";
}

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

function OutputSchemaEditor({
  config,
  outputSchemaKey,
  onUpdateConfig,
  disabled,
}: {
  config: Record<string, unknown>;
  outputSchemaKey: "dbOutputSchema" | "httpOutputSchema";
  onUpdateConfig: (key: string, value: unknown) => void;
  disabled: boolean;
}) {
  const [schemaEditorMode, setSchemaEditorMode] =
    useState<SchemaEditorMode>("builder");
  const schemaValue = readOutputSchema(config, outputSchemaKey);
  const schema = useMemo(
    () => parseWorkflowSchemaFieldsString(schemaValue),
    [schemaValue]
  );
  const schemaJsonValue = useMemo(
    () =>
      JSON.stringify(workflowSchemaFieldsToJsonSchemaDocument(schema), null, 2),
    [schema]
  );
  const [schemaJsonDraft, setSchemaJsonDraft] = useState(schemaJsonValue);
  const [schemaJsonError, setSchemaJsonError] = useState("");

  const handleSchemaJsonChange = (nextValue: string) => {
    setSchemaJsonDraft(nextValue);

    if (!nextValue.trim()) {
      onUpdateConfig(outputSchemaKey, "");
      setSchemaJsonError("");
      return;
    }

    try {
      const parsed = JSON.parse(nextValue);
      const parsedSchema = parseWorkflowSchemaFieldsOrJsonSchema(parsed);

      if (!parsedSchema) {
        setSchemaJsonError(
          "Schema must be either a field array or a JSON Schema object with top-level properties."
        );
        return;
      }

      onUpdateConfig(outputSchemaKey, JSON.stringify(parsedSchema));
      setSchemaJsonError("");
    } catch {
      setSchemaJsonError("Schema is not valid JSON.");
    }
  };

  return (
    <div className="space-y-2">
      <Label>Output Schema (Optional)</Label>
      <Tabs
        onValueChange={(value) => {
          if (!isSchemaEditorMode(value)) {
            return;
          }

          setSchemaEditorMode(value);
          if (value === "json") {
            setSchemaJsonDraft(schemaJsonValue);
            setSchemaJsonError("");
          }
        }}
        value={schemaEditorMode}
      >
        <TabsList className="grid w-full max-w-[280px] grid-cols-2">
          <TabsTrigger value="builder">Builder</TabsTrigger>
          <TabsTrigger value="json">JSON Schema</TabsTrigger>
        </TabsList>
        <TabsContent className="space-y-3" value="builder">
          <SchemaBuilder
            disabled={disabled}
            onChange={(nextSchema) =>
              onUpdateConfig(outputSchemaKey, JSON.stringify(nextSchema))
            }
            schema={schema}
          />
        </TabsContent>
        <TabsContent className="space-y-3" value="json">
          <div className="overflow-hidden rounded-md border">
            <CodeEditor
              defaultLanguage="json"
              height="230px"
              onChange={(value) => handleSchemaJsonChange(value || "")}
              options={{
                minimap: { enabled: false },
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                fontSize: 12,
                readOnly: disabled,
                wordWrap: "on",
              }}
              value={schemaJsonDraft}
            />
          </div>
          <div className="min-h-5">
            {schemaJsonError ? (
              <p className="text-destructive text-xs">{schemaJsonError}</p>
            ) : (
              <p className="text-muted-foreground text-xs">
                Changes auto-apply when JSON is valid. Supports top-level JSON
                Schema <code>properties</code>.
              </p>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Database Query fields component
function DatabaseQueryFields({
  config,
  onUpdateConfig,
  disabled,
}: {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: unknown) => void;
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
            value={readConfigString(config, "dbQuery")}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          The DATABASE_URL from your project integrations will be used to
          execute this query.
        </p>
      </div>
      <OutputSchemaEditor
        config={config}
        disabled={disabled}
        onUpdateConfig={onUpdateConfig}
        outputSchemaKey="dbOutputSchema"
      />
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
  onUpdateConfig: (key: string, value: unknown) => void;
  disabled: boolean;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="httpMethod">HTTP Method</Label>
        <Select
          disabled={disabled}
          onValueChange={(value) => onUpdateConfig("httpMethod", value)}
          value={readConfigString(config, "httpMethod", "POST")}
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
          value={readConfigString(config, "endpoint")}
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
            value={readConfigString(config, "httpHeaders", "{}")}
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
            value={readConfigString(config, "httpBody", "{}")}
          />
        </div>
        {config?.httpMethod === "GET" && (
          <p className="text-muted-foreground text-xs">
            Body is disabled for GET requests
          </p>
        )}
      </div>
      <OutputSchemaEditor
        config={config}
        disabled={disabled}
        onUpdateConfig={onUpdateConfig}
        outputSchemaKey="httpOutputSchema"
      />
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
  onUpdateConfig: (key: string, value: unknown) => void;
  disabled: boolean;
}) {
  return (
    <ConditionBuilderRow
      config={config}
      description="Build a condition from trigger and upstream action output fields. Timestamp fields support relative and absolute time filters."
      disabled={disabled}
      label="Condition"
      onUpdateConfig={onUpdateConfig}
    />
  );
}

type WaitFieldProps = {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: unknown) => void;
  disabled: boolean;
};

function getDelayTimingMode(
  config: Record<string, unknown>
): "duration" | "until" {
  const delayTimingModeRaw = readConfigString(config, "waitDelayTimingMode");
  if (delayTimingModeRaw === "duration" || delayTimingModeRaw === "until") {
    return delayTimingModeRaw;
  }

  const waitUntil = readConfigString(config, "waitUntil");
  if (waitUntil.trim()) {
    return "until";
  }

  return "duration";
}

function DelayWaitFields({ config, onUpdateConfig, disabled }: WaitFieldProps) {
  const waitGateMode = readConfigString(config, "waitGateMode", "off");
  const configuredWaitUntil = readConfigString(config, "waitUntil");
  const configuredWaitDuration = readConfigString(config, "waitDuration");
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
            fieldType="duration"
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
              fieldType="timestamp"
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
              fieldType="duration"
              id="waitOffset"
              onChange={(value) => onUpdateConfig("waitOffset", value)}
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
          value={readConfigString(config, "waitTimezone", "UTC")}
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
          value={readConfigString(config, "waitForEvents")}
        />
        <p className="text-muted-foreground text-xs">
          Leave empty to resume on any matching event for the same entity.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="waitTimeout">Stop waiting after (optional)</Label>
        <TemplateBadgeInput
          disabled={disabled}
          fieldType="duration"
          id="waitTimeout"
          onChange={(value) => onUpdateConfig("waitTimeout", value)}
          placeholder="48h"
          value={readConfigString(config, "waitTimeout")}
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
          value={readConfigString(config, "waitHookToken")}
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
  const waitMode = readConfigString(config, "waitMode", "delay");

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
  onUpdateConfig: (key: string, value: unknown) => void;
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

const SYSTEM_ACTION_ID_SET = new Set(SYSTEM_ACTIONS.map((action) => action.id));

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
  if (SYSTEM_ACTION_ID_SET.has(actionType)) {
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
  if (SYSTEM_ACTION_ID_SET.has(actionType)) {
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
  const actionType = readConfigString(config, "actionType");
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

  const category = actionType ? getCategoryForAction(actionType) || "" : "";
  const setIntegrationsVersion = useSetAtom(integrationsVersionAtom);
  const globalIntegrations = useAtomValue(integrationsAtom);
  const { push } = useOverlay();

  const handleCategoryChange = (newCategory: string) => {
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
    onUpdateConfig(key, value);
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
    return isIntegrationType(action?.integration)
      ? action.integration
      : undefined;
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
                  const actionIntegrationType =
                    typeof action.integration === "string"
                      ? action.integration
                      : undefined;
                  const integration = actionIntegrationType
                    ? integrations.find(
                        (item) => item.type === actionIntegrationType
                      )
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
            value={readConfigString(config, "integrationId")}
          />
        </div>
      )}

      {/* System actions - hardcoded config fields */}
      <SystemActionFields
        actionType={readConfigString(config, "actionType")}
        config={config}
        disabled={disabled}
        onUpdateConfig={onUpdateConfig}
      />

      {/* Plugin actions - declarative config fields */}
      {pluginAction && !SYSTEM_ACTION_ID_SET.has(actionType) && (
        <ActionConfigRenderer
          config={config}
          disabled={disabled}
          fields={pluginAction.configFields}
          onUpdateConfig={handlePluginUpdateConfig}
        />
      )}
    </>
  );
}
