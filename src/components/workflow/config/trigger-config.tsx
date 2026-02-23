import cronstrue from "cronstrue";
import { ChevronDown, Clock, Copy, TriangleAlert, Webhook } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { getRuntimeTriggers } from "@/client/lib/runtime-extensions";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TimezoneSelect } from "@/components/ui/timezone-select";
import { cn } from "@/shared/utils";
import { parseCsvSet } from "@/shared/utils/csv";
import { getValueByPath } from "@/shared/utils/object-path";
import { parseScheduleExpression } from "@/shared/utils/schedule-expression";
import {
  parseWorkflowSchemaFieldsOrJsonSchema,
  workflowSchemaFieldsToJsonSchemaDocument,
} from "@/shared/workflow/schema-codec";
import { ActionConfigRenderer } from "./action-config-renderer";
import { SchemaBuilder, type SchemaField } from "./schema-builder";

type TriggerConfigProps = {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: unknown) => void;
  disabled: boolean;
  workflowId?: string;
};

type WebhookPreset = {
  id: string;
  label: string;
  payload: Record<string, unknown>;
};

type SchemaEditorMode = "builder" | "json";
type WebhookSectionKey =
  | "endpoint"
  | "requestSchema"
  | "outputSchema"
  | "routing"
  | "payload"
  | "summary";

type WebhookSectionState = Record<WebhookSectionKey, boolean>;

const DEFAULT_WEBHOOK_SECTION_STATE: WebhookSectionState = {
  endpoint: true,
  requestSchema: true,
  outputSchema: false,
  routing: false,
  payload: false,
  summary: false,
};

const WEBHOOK_PRESETS: WebhookPreset[] = [
  {
    id: "appointment-created",
    label: "Appointment Created",
    payload: {
      type: "appointment.create",
      timestamp: "2026-02-11T18:00:00Z",
      data: {
        id: "appt_123",
        startsAt: "2026-02-12T15:00:00-05:00",
        timezone: "America/New_York",
        status: "scheduled",
      },
    },
  },
  {
    id: "appointment-rescheduled",
    label: "Appointment Rescheduled",
    payload: {
      type: "appointment.rescheduled",
      timestamp: "2026-02-11T19:00:00Z",
      data: {
        id: "appt_123",
        startsAt: "2026-02-13T10:00:00-05:00",
        timezone: "America/New_York",
        status: "rescheduled",
      },
    },
  },
  {
    id: "appointment-canceled",
    label: "Appointment Canceled",
    payload: {
      type: "appointment.canceled",
      timestamp: "2026-02-11T20:00:00Z",
      data: {
        id: "appt_123",
        status: "canceled",
      },
    },
  },
];

const ISO8601_TIMESTAMP_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigString(
  config: Record<string, unknown>,
  key: string,
  fallback = ""
): string {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
}

function readSchemaFromConfigKey(
  config: Record<string, unknown>,
  key: string
): SchemaField[] {
  if (typeof config[key] !== "string" || !config[key]) {
    return [];
  }

  try {
    const parsed = JSON.parse(config[key]);
    return parseWorkflowSchemaFieldsOrJsonSchema(parsed) ?? [];
  } catch {
    return [];
  }
}

function readWebhookOutputSchema(
  config: Record<string, unknown>
): SchemaField[] {
  return readSchemaFromConfigKey(config, "webhookOutputSchema");
}

function isSchemaEditorMode(value: string): value is SchemaEditorMode {
  return value === "builder" || value === "json";
}

function isIso8601Timestamp(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  if (!ISO8601_TIMESTAMP_REGEX.test(normalized)) {
    return false;
  }

  return !Number.isNaN(Date.parse(normalized));
}

function inferPrimitiveType(
  value: unknown
): "string" | "number" | "boolean" | "timestamp" {
  if (typeof value === "number") {
    return "number";
  }

  if (typeof value === "boolean") {
    return "boolean";
  }

  if (typeof value === "string" && isIso8601Timestamp(value)) {
    return "timestamp";
  }

  return "string";
}

function inferSchemaField(name: string, value: unknown): SchemaField {
  if (Array.isArray(value)) {
    const first = value.at(0);

    if (isRecord(first)) {
      return {
        name,
        type: "array",
        itemType: "object",
        fields: inferSchemaFromPayload(first),
      };
    }

    return {
      name,
      type: "array",
      itemType: inferPrimitiveType(first),
    };
  }

  if (isRecord(value)) {
    return {
      name,
      type: "object",
      fields: inferSchemaFromPayload(value),
    };
  }

  return {
    name,
    type: inferPrimitiveType(value),
  };
}

function inferSchemaFromPayload(
  payload: Record<string, unknown>
): SchemaField[] {
  return Object.entries(payload).map(([key, value]) =>
    inferSchemaField(key, value)
  );
}

type SchemaPathOption = {
  path: string;
  type: SchemaField["type"] | SchemaField["itemType"];
};

function flattenSchemaPathOptions(
  schema: SchemaField[],
  prefix = ""
): SchemaPathOption[] {
  const paths: SchemaPathOption[] = [];

  for (const field of schema) {
    const fieldName = field.name.trim();

    if (!fieldName) {
      continue;
    }

    const currentPath = prefix ? `${prefix}.${fieldName}` : fieldName;
    paths.push({ path: currentPath, type: field.type });

    if (field.type === "object" && field.fields?.length) {
      paths.push(...flattenSchemaPathOptions(field.fields, currentPath));
    }

    if (
      field.type === "array" &&
      field.itemType === "object" &&
      field.fields?.length
    ) {
      paths.push(...flattenSchemaPathOptions(field.fields, `${currentPath}.0`));
    }
  }

  return paths;
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

function WebhookConfigSection({
  title,
  description,
  open,
  onOpenChange,
  warningCount,
  children,
}: {
  title: string;
  description: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  warningCount?: number;
  children: ReactNode;
}) {
  return (
    <Collapsible onOpenChange={onOpenChange} open={open}>
      <CollapsibleTrigger
        className="group relative flex w-full items-center rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        type="button"
      >
        <div className="space-y-0.5 pr-10">
          <p className="font-medium text-sm">{title}</p>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
        <div className="pointer-events-none absolute top-2 right-2 flex min-h-8 w-6 flex-col items-center gap-1">
          <ChevronDown
            className={cn(
              "size-4 text-muted-foreground transition-transform",
              open ? "" : "-rotate-90"
            )}
          />
          {warningCount && warningCount > 0 ? (
            <span className="inline-flex min-w-5 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 font-medium text-[10px] text-amber-700 dark:text-amber-200">
              {warningCount}
            </span>
          ) : null}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2 pb-3">
        <div className="space-y-3 pt-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Trigger config intentionally combines form, summary, and warnings in one panel.
export function TriggerConfig({
  config,
  onUpdateConfig,
  disabled,
  workflowId,
}: TriggerConfigProps) {
  const [requestSchemaEditorMode, setRequestSchemaEditorMode] =
    useState<SchemaEditorMode>("builder");
  const [outputSchemaEditorMode, setOutputSchemaEditorMode] =
    useState<SchemaEditorMode>("builder");
  const triggerType = readConfigString(config, "triggerType", "Webhook");
  const runtimeTriggers = useMemo(
    () =>
      getRuntimeTriggers().filter(
        (trigger) => trigger.type !== "Webhook" && trigger.type !== "Schedule"
      ),
    []
  );
  const selectedRuntimeTrigger = useMemo(
    () => runtimeTriggers.find((trigger) => trigger.type === triggerType),
    [runtimeTriggers, triggerType]
  );
  const scheduleExpression = readConfigString(config, "scheduleExpression");
  const scheduleCron = readConfigString(config, "scheduleCron");
  const resolvedSchedule = useMemo(
    () => parseScheduleExpression(scheduleExpression || scheduleCron),
    [scheduleExpression, scheduleCron]
  );

  const webhookUrl = workflowId
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/api/workflows/${workflowId}/webhook`
    : "";

  const eventPath = readConfigString(config, "webhookEventPath");
  const correlationPath = readConfigString(
    config,
    "webhookCorrelationPath",
    "data.id"
  );
  const createEvents = readConfigString(config, "webhookCreateEvents");
  const updateEvents = readConfigString(config, "webhookUpdateEvents");
  const deleteEvents = readConfigString(config, "webhookDeleteEvents");
  const mockRequest = readConfigString(config, "webhookMockRequest");
  const scheduleTimezone = readConfigString(
    config,
    "scheduleTimezone",
    "America/New_York"
  );
  const requestSchema = readSchemaFromConfigKey(config, "webhookSchema");
  const requestSchemaJsonValue = useMemo(
    () =>
      JSON.stringify(
        workflowSchemaFieldsToJsonSchemaDocument(requestSchema),
        null,
        2
      ),
    [requestSchema]
  );
  const outputSchema = readWebhookOutputSchema(config);
  const outputSchemaJsonValue = useMemo(
    () =>
      JSON.stringify(
        workflowSchemaFieldsToJsonSchemaDocument(outputSchema),
        null,
        2
      ),
    [outputSchema]
  );
  const [requestSchemaJsonDraft, setRequestSchemaJsonDraft] = useState(
    requestSchemaJsonValue
  );
  const [requestSchemaJsonError, setRequestSchemaJsonError] = useState("");
  const [outputSchemaJsonDraft, setOutputSchemaJsonDraft] = useState(
    outputSchemaJsonValue
  );
  const [outputSchemaJsonError, setOutputSchemaJsonError] = useState("");
  const [webhookSections, setWebhookSections] = useState<WebhookSectionState>(
    DEFAULT_WEBHOOK_SECTION_STATE
  );

  const schemaPathOptions = useMemo(
    () => flattenSchemaPathOptions(requestSchema),
    [requestSchema]
  );
  const schemaPaths = useMemo(
    () => schemaPathOptions.map((option) => option.path),
    [schemaPathOptions]
  );
  const eventPathOptions = useMemo(() => {
    const options = [...schemaPathOptions];
    if (eventPath && !options.some((option) => option.path === eventPath)) {
      options.unshift({ path: eventPath, type: "string" });
    }
    return options;
  }, [eventPath, schemaPathOptions]);
  const correlationPathOptions = useMemo(() => {
    const options = [...schemaPathOptions];
    if (
      correlationPath &&
      !options.some((option) => option.path === correlationPath)
    ) {
      options.unshift({ path: correlationPath, type: "string" });
    }
    return options;
  }, [correlationPath, schemaPathOptions]);

  const parsedMockRequest = useMemo(() => {
    if (!mockRequest.trim()) {
      return { payload: null, error: "" };
    }

    try {
      return {
        payload: JSON.parse(mockRequest),
        error: "",
      };
    } catch {
      return {
        payload: null,
        error: "Sample payload is not valid JSON.",
      };
    }
  }, [mockRequest]);

  const parsedCronDescription = (() => {
    if (!(scheduleExpression.trim() || scheduleCron.trim())) {
      return {
        description: "",
        error: "",
        normalizedCron: "",
        source: "cron" as const,
      };
    }

    try {
      return {
        description: cronstrue.toString(resolvedSchedule?.cron ?? "", {
          verbose: true,
        }),
        error: "",
        normalizedCron: resolvedSchedule?.cron ?? "",
        source: resolvedSchedule?.source ?? ("cron" as const),
      };
    } catch (error) {
      return {
        description: "",
        error:
          error instanceof Error ? error.message : "Invalid cron expression.",
        normalizedCron: "",
        source: resolvedSchedule?.source ?? ("cron" as const),
      };
    }
  })();

  const handleScheduleExpressionChange = (value: string) => {
    onUpdateConfig("scheduleExpression", value);
    onUpdateConfig(
      "scheduleCron",
      parseScheduleExpression(value)?.cron ?? value
    );
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Warning assembly validates multiple independent webhook configuration rules.
  const { configWarnings, payloadWarnings } = useMemo(() => {
    const configItems: string[] = [];
    const payloadItems: string[] = [];

    if (!eventPath.trim()) {
      configItems.push("Event type field path is empty.");
    }

    if (!correlationPath.trim()) {
      configItems.push("Entity ID field path is empty.");
    }

    if (requestSchema.length === 0) {
      configItems.push(
        "Define a request schema first, then pick routing fields from that schema."
      );
    } else {
      if (eventPath && !schemaPaths.includes(eventPath)) {
        configItems.push(
          `Event type field "${eventPath}" is not in request schema.`
        );
      }

      if (correlationPath && !schemaPaths.includes(correlationPath)) {
        configItems.push(
          `Entity ID field "${correlationPath}" is not in request schema.`
        );
      }
    }

    const createSet = parseCsvSet(createEvents);
    const updateSet = parseCsvSet(updateEvents);
    const deleteSet = parseCsvSet(deleteEvents);

    if (createSet.size === 0 && updateSet.size === 0 && deleteSet.size === 0) {
      configItems.push(
        "No events are configured. Incoming webhooks will not start, restart, or stop runs."
      );
    }

    const overlappingCreateUpdate = [...createSet].filter((eventName) =>
      updateSet.has(eventName)
    );
    if (overlappingCreateUpdate.length > 0) {
      configItems.push(
        `These events appear in both start and restart lists: ${overlappingCreateUpdate.join(", ")}`
      );
    }

    const overlappingCreateDelete = [...createSet].filter((eventName) =>
      deleteSet.has(eventName)
    );
    if (overlappingCreateDelete.length > 0) {
      configItems.push(
        `These events appear in both start and stop lists: ${overlappingCreateDelete.join(", ")}`
      );
    }

    const overlappingUpdateDelete = [...updateSet].filter((eventName) =>
      deleteSet.has(eventName)
    );
    if (overlappingUpdateDelete.length > 0) {
      configItems.push(
        `These events appear in both restart and stop lists: ${overlappingUpdateDelete.join(", ")}`
      );
    }

    if (parsedMockRequest.error) {
      payloadItems.push(parsedMockRequest.error);
    } else if (parsedMockRequest.payload) {
      const eventValue = getValueByPath(parsedMockRequest.payload, eventPath);
      const correlationValue = getValueByPath(
        parsedMockRequest.payload,
        correlationPath
      );

      if (eventValue === undefined) {
        payloadItems.push(
          `Sample payload is missing event type at "${eventPath}".`
        );
      }

      if (correlationValue === undefined) {
        payloadItems.push(
          `Sample payload is missing entity ID at "${correlationPath}".`
        );
      }

      if (requestSchema.length > 0) {
        const missingSchemaPaths = schemaPaths.filter(
          (path) =>
            getValueByPath(parsedMockRequest.payload, path) === undefined
        );

        if (missingSchemaPaths.length > 0) {
          payloadItems.push(
            `Schema fields missing from sample payload: ${missingSchemaPaths.slice(0, 3).join(", ")}${missingSchemaPaths.length > 3 ? ", ..." : ""}`
          );
        }
      }
    }

    return {
      configWarnings: configItems,
      payloadWarnings: payloadItems,
    };
  }, [
    correlationPath,
    createEvents,
    deleteEvents,
    eventPath,
    parsedMockRequest.error,
    parsedMockRequest.payload,
    requestSchema,
    schemaPaths,
    updateEvents,
  ]);

  const setWebhookSectionOpen = (section: WebhookSectionKey, open: boolean) => {
    setWebhookSections((prev) => {
      if (prev[section] === open) {
        return prev;
      }

      return { ...prev, [section]: open };
    });
  };
  const routingSectionOpen =
    webhookSections.routing || configWarnings.length > 0;
  const payloadSectionOpen =
    webhookSections.payload || payloadWarnings.length > 0;

  const handleCopyWebhookUrl = () => {
    if (webhookUrl) {
      navigator.clipboard.writeText(webhookUrl);
      toast.success("Webhook URL copied to clipboard");
    }
  };

  const handleLoadPreset = (preset: WebhookPreset) => {
    onUpdateConfig(
      "webhookMockRequest",
      JSON.stringify(preset.payload, null, 2)
    );

    const inferredSchema = inferSchemaFromPayload(preset.payload);
    onUpdateConfig("webhookSchema", JSON.stringify(inferredSchema));
    onUpdateConfig("webhookOutputSchema", JSON.stringify(inferredSchema));

    toast.success(`${preset.label} example loaded (schema synced)`);
  };

  const handleCustomTriggerConfigUpdate = (key: string, value: unknown) => {
    onUpdateConfig(key, value);
  };

  const handleRequestSchemaJsonChange = (nextValue: string) => {
    setRequestSchemaJsonDraft(nextValue);

    if (!nextValue.trim()) {
      onUpdateConfig("webhookSchema", "");
      setRequestSchemaJsonError("");
      return;
    }

    try {
      const parsed = JSON.parse(nextValue);
      const parsedSchema = parseWorkflowSchemaFieldsOrJsonSchema(parsed);

      if (!parsedSchema) {
        setRequestSchemaJsonError(
          "Schema must be either a field array or a JSON Schema object with top-level properties."
        );
        return;
      }

      onUpdateConfig("webhookSchema", JSON.stringify(parsedSchema));
      setRequestSchemaJsonError("");
    } catch {
      setRequestSchemaJsonError("Schema is not valid JSON.");
    }
  };

  const handleOutputSchemaJsonChange = (nextValue: string) => {
    setOutputSchemaJsonDraft(nextValue);

    if (!nextValue.trim()) {
      onUpdateConfig("webhookOutputSchema", "");
      setOutputSchemaJsonError("");
      return;
    }

    try {
      const parsed = JSON.parse(nextValue);
      const parsedSchema = parseWorkflowSchemaFieldsOrJsonSchema(parsed);

      if (!parsedSchema) {
        setOutputSchemaJsonError(
          "Schema must be either a field array or a JSON Schema object with top-level properties."
        );
        return;
      }

      onUpdateConfig("webhookOutputSchema", JSON.stringify(parsedSchema));
      setOutputSchemaJsonError("");
    } catch {
      setOutputSchemaJsonError("Schema is not valid JSON.");
    }
  };

  return (
    <>
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="triggerType">
          Trigger Type
        </Label>
        <Select
          disabled={disabled}
          onValueChange={(value) => onUpdateConfig("triggerType", value)}
          value={triggerType}
        >
          <SelectTrigger className="w-full" id="triggerType">
            <SelectValue placeholder="Select trigger type" />
          </SelectTrigger>
          <SelectContent>
            {/* Keep this list aligned with first-class trigger schemas in
                `src/shared/workflow/schemas.ts` and built-in registrations in
                `src/shared/workflow/trigger-registry.ts`. */}
            <SelectItem value="Schedule">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Schedule
              </div>
            </SelectItem>
            <SelectItem value="Webhook">
              <div className="flex items-center gap-2">
                <Webhook className="h-4 w-4" />
                Webhook
              </div>
            </SelectItem>
            {runtimeTriggers.length > 0 && <SelectSeparator />}
            {runtimeTriggers.map((trigger) => (
              <SelectItem key={trigger.type} value={trigger.type}>
                <div className="flex items-center gap-2">
                  <OptionLogo
                    fallback={<Webhook className="h-4 w-4" />}
                    label={trigger.label}
                    logoUrl={trigger.logoUrl}
                  />
                  <span>{trigger.label}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {triggerType !== "Webhook" && triggerType !== "Schedule" && (
        <div className="space-y-3 rounded-lg border border-muted bg-muted/30 p-3">
          <div className="space-y-2">
            {selectedRuntimeTrigger?.logoUrl && (
              <img
                alt={`${selectedRuntimeTrigger.label} logo`}
                className="h-6 w-6 rounded-sm object-contain"
                height={24}
                loading="lazy"
                src={selectedRuntimeTrigger.logoUrl}
                width={24}
              />
            )}
            <p className="font-medium text-sm">Custom Trigger</p>
            <p className="text-muted-foreground text-xs">
              {selectedRuntimeTrigger?.description ??
                "This trigger is provided by your server extension configuration."}
            </p>
          </div>

          {(selectedRuntimeTrigger?.configFields?.length ?? 0) > 0 && (
            <div className="space-y-3 rounded-md border bg-background p-3">
              <p className="font-medium text-xs uppercase tracking-wide">
                Configuration
              </p>
              <ActionConfigRenderer
                config={config}
                disabled={disabled}
                fields={selectedRuntimeTrigger?.configFields ?? []}
                onUpdateConfig={handleCustomTriggerConfigUpdate}
              />
            </div>
          )}
        </div>
      )}

      {triggerType === "Webhook" && (
        <div className="overflow-hidden rounded-md border">
          <div className="p-2">
            <WebhookConfigSection
              description="Send events to this endpoint to trigger workflow runs."
              onOpenChange={(open) => setWebhookSectionOpen("endpoint", open)}
              open={webhookSections.endpoint}
              title="Webhook Endpoint"
            >
              <div className="space-y-2">
                <Label className="ml-1" htmlFor="webhookUrl">
                  Webhook URL
                </Label>
                <div className="flex gap-2">
                  <Input
                    className="font-mono text-xs"
                    disabled
                    id="webhookUrl"
                    value={
                      webhookUrl || "Save workflow to generate webhook URL"
                    }
                  />
                  <Button
                    aria-label="Copy webhook URL"
                    disabled={!webhookUrl}
                    onClick={handleCopyWebhookUrl}
                    size="icon"
                    type="button"
                    variant="outline"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </WebhookConfigSection>
          </div>

          <Separator />

          <div className="p-2">
            <WebhookConfigSection
              description="Define the request contract used by routing and autocomplete."
              onOpenChange={(open) =>
                setWebhookSectionOpen("requestSchema", open)
              }
              open={webhookSections.requestSchema}
              title="Request Schema"
            >
              <Tabs
                onValueChange={(value) => {
                  if (!isSchemaEditorMode(value)) {
                    return;
                  }
                  setRequestSchemaEditorMode(value);
                  if (value === "json") {
                    setRequestSchemaJsonDraft(requestSchemaJsonValue);
                    setRequestSchemaJsonError("");
                  }
                }}
                value={requestSchemaEditorMode}
              >
                <TabsList className="grid w-full max-w-[280px] grid-cols-2">
                  <TabsTrigger value="builder">Builder</TabsTrigger>
                  <TabsTrigger value="json">JSON Schema</TabsTrigger>
                </TabsList>
                <TabsContent className="space-y-3" value="builder">
                  <SchemaBuilder
                    disabled={disabled}
                    onChange={(nextSchema) =>
                      onUpdateConfig(
                        "webhookSchema",
                        JSON.stringify(nextSchema)
                      )
                    }
                    schema={requestSchema}
                  />
                </TabsContent>
                <TabsContent className="space-y-3" value="json">
                  <div className="overflow-hidden rounded-md border">
                    <CodeEditor
                      defaultLanguage="json"
                      height="230px"
                      onChange={(value) =>
                        handleRequestSchemaJsonChange(value || "")
                      }
                      options={{
                        minimap: { enabled: false },
                        lineNumbers: "on",
                        scrollBeyondLastLine: false,
                        fontSize: 12,
                        readOnly: disabled,
                        wordWrap: "on",
                      }}
                      value={requestSchemaJsonDraft}
                    />
                  </div>
                  <div className="min-h-5">
                    {requestSchemaJsonError ? (
                      <p className="text-destructive text-xs">
                        {requestSchemaJsonError}
                      </p>
                    ) : (
                      <p className="text-muted-foreground text-xs">
                        Changes auto-apply when JSON is valid. Supports
                        top-level JSON Schema <code>properties</code>.
                      </p>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            </WebhookConfigSection>
          </div>

          <Separator />

          <div className="p-2">
            <WebhookConfigSection
              description="Define the trigger output contract consumed by downstream actions."
              onOpenChange={(open) =>
                setWebhookSectionOpen("outputSchema", open)
              }
              open={webhookSections.outputSchema}
              title="Output Schema"
            >
              <Tabs
                onValueChange={(value) => {
                  if (!isSchemaEditorMode(value)) {
                    return;
                  }
                  setOutputSchemaEditorMode(value);
                  if (value === "json") {
                    setOutputSchemaJsonDraft(outputSchemaJsonValue);
                    setOutputSchemaJsonError("");
                  }
                }}
                value={outputSchemaEditorMode}
              >
                <TabsList className="grid w-full max-w-[280px] grid-cols-2">
                  <TabsTrigger value="builder">Builder</TabsTrigger>
                  <TabsTrigger value="json">JSON Schema</TabsTrigger>
                </TabsList>
                <TabsContent className="space-y-3" value="builder">
                  <SchemaBuilder
                    disabled={disabled}
                    onChange={(nextSchema) =>
                      onUpdateConfig(
                        "webhookOutputSchema",
                        JSON.stringify(nextSchema)
                      )
                    }
                    schema={outputSchema}
                  />
                </TabsContent>
                <TabsContent className="space-y-3" value="json">
                  <div className="overflow-hidden rounded-md border">
                    <CodeEditor
                      defaultLanguage="json"
                      height="230px"
                      onChange={(value) =>
                        handleOutputSchemaJsonChange(value || "")
                      }
                      options={{
                        minimap: { enabled: false },
                        lineNumbers: "on",
                        scrollBeyondLastLine: false,
                        fontSize: 12,
                        readOnly: disabled,
                        wordWrap: "on",
                      }}
                      value={outputSchemaJsonDraft}
                    />
                  </div>
                  <div className="min-h-5">
                    {outputSchemaJsonError ? (
                      <p className="text-destructive text-xs">
                        {outputSchemaJsonError}
                      </p>
                    ) : (
                      <p className="text-muted-foreground text-xs">
                        Changes auto-apply when JSON is valid. Supports
                        top-level JSON Schema <code>properties</code>.
                      </p>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            </WebhookConfigSection>
          </div>

          <Separator />

          <div className="p-2">
            <WebhookConfigSection
              description="Map webhook payload values to workflow start, restart, and stop behavior."
              onOpenChange={(open) => setWebhookSectionOpen("routing", open)}
              open={routingSectionOpen}
              title="Routing Rules"
              warningCount={configWarnings.length}
            >
              <div className="space-y-2">
                <Label htmlFor="guidedEventPath">
                  Which schema field contains the event value?
                </Label>
                <Select
                  disabled={disabled || schemaPathOptions.length === 0}
                  onValueChange={(value) => {
                    setWebhookSectionOpen("routing", true);
                    onUpdateConfig("webhookEventPath", value);
                  }}
                  value={eventPath}
                >
                  <SelectTrigger id="guidedEventPath">
                    <SelectValue placeholder="Select a schema path" />
                  </SelectTrigger>
                  <SelectContent>
                    {eventPathOptions.map((option) => (
                      <SelectItem
                        key={`event-path-${option.path}`}
                        value={option.path}
                      >
                        {option.path}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  This should point to a string field like <code>event</code> or{" "}
                  <code>meta.action</code>.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="guidedCorrelationPath">
                  Which schema field identifies the entity?
                </Label>
                <Select
                  disabled={disabled || schemaPathOptions.length === 0}
                  onValueChange={(value) => {
                    setWebhookSectionOpen("routing", true);
                    onUpdateConfig("webhookCorrelationPath", value);
                  }}
                  value={correlationPath}
                >
                  <SelectTrigger id="guidedCorrelationPath">
                    <SelectValue placeholder="Select a schema path" />
                  </SelectTrigger>
                  <SelectContent>
                    {correlationPathOptions.map((option) => (
                      <SelectItem
                        key={`correlation-path-${option.path}`}
                        value={option.path}
                      >
                        {option.path}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  Runs with the same value here are cancelled or resumed
                  together.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="guidedCreateEvents">
                  Values that start a run
                </Label>
                <Input
                  disabled={disabled}
                  id="guidedCreateEvents"
                  onChange={(e) => {
                    setWebhookSectionOpen("routing", true);
                    onUpdateConfig("webhookCreateEvents", e.target.value);
                  }}
                  placeholder="appointment.create"
                  value={createEvents}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="guidedUpdateEvents">
                  Values that restart timing
                </Label>
                <Input
                  disabled={disabled}
                  id="guidedUpdateEvents"
                  onChange={(e) => {
                    setWebhookSectionOpen("routing", true);
                    onUpdateConfig("webhookUpdateEvents", e.target.value);
                  }}
                  placeholder="appointment.rescheduled"
                  value={updateEvents}
                />
                <p className="text-muted-foreground text-xs">
                  Matching waiting runs are cancelled first, then a new run
                  starts.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="guidedDeleteEvents">
                  Values that stop runs
                </Label>
                <Input
                  disabled={disabled}
                  id="guidedDeleteEvents"
                  onChange={(e) => {
                    setWebhookSectionOpen("routing", true);
                    onUpdateConfig("webhookDeleteEvents", e.target.value);
                  }}
                  placeholder="appointment.canceled"
                  value={deleteEvents}
                />
                <p className="text-muted-foreground text-xs">
                  Matching waiting runs are cancelled and no new run is created.
                </p>
              </div>

              {schemaPathOptions.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  Add request schema properties first to enable routing field
                  selection.
                </p>
              ) : null}

              {configWarnings.length > 0 ? (
                <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                  <div className="flex items-center gap-2">
                    <TriangleAlert className="h-4 w-4 text-amber-600" />
                    <p className="font-medium text-amber-700 text-sm dark:text-amber-300">
                      Configuration Warnings
                    </p>
                  </div>
                  <div className="space-y-1">
                    {configWarnings.map((warning) => (
                      <p
                        className="text-amber-700 text-xs dark:text-amber-200"
                        key={warning}
                      >
                        {warning}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}
            </WebhookConfigSection>
          </div>

          <Separator />

          <div className="p-2">
            <WebhookConfigSection
              description="Use local examples to validate routing and schema assumptions."
              onOpenChange={(open) => setWebhookSectionOpen("payload", open)}
              open={payloadSectionOpen}
              title="Sample Payload"
              warningCount={payloadWarnings.length}
            >
              <Label htmlFor="webhookMockRequest">
                Sample Payload (Optional)
              </Label>
              <div className="flex flex-wrap gap-2">
                {WEBHOOK_PRESETS.map((preset) => (
                  <Button
                    disabled={disabled}
                    key={preset.id}
                    onClick={() => handleLoadPreset(preset)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
              <div className="overflow-hidden rounded-md border">
                <CodeEditor
                  defaultLanguage="json"
                  height="190px"
                  onChange={(value) => {
                    setWebhookSectionOpen("payload", true);
                    onUpdateConfig("webhookMockRequest", value || "");
                  }}
                  options={{
                    minimap: { enabled: false },
                    lineNumbers: "on",
                    scrollBeyondLastLine: false,
                    fontSize: 12,
                    readOnly: disabled,
                    wordWrap: "on",
                  }}
                  value={mockRequest}
                />
              </div>
              <div className="min-h-5">
                {payloadWarnings.length > 0 ? (
                  <div className="space-y-1">
                    {payloadWarnings.map((warning) => (
                      <p
                        className="text-amber-700 text-xs dark:text-amber-200"
                        key={warning}
                      >
                        {warning}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>
            </WebhookConfigSection>
          </div>

          <Separator />

          <div className="p-2">
            <WebhookConfigSection
              description="Quick reference for how current event values map to runtime behavior."
              onOpenChange={(open) => setWebhookSectionOpen("summary", open)}
              open={webhookSections.summary}
              title="Behavior Summary"
            >
              <p className="text-sm">
                Start runs when event is:{" "}
                <span className="font-mono text-xs">
                  {createEvents.trim() || "(none)"}
                </span>
              </p>
              <p className="text-sm">
                Restart runs when event is:{" "}
                <span className="font-mono text-xs">
                  {updateEvents.trim() || "(none)"}
                </span>
              </p>
              <p className="text-sm">
                Stop runs when event is:{" "}
                <span className="font-mono text-xs">
                  {deleteEvents.trim() || "(none)"}
                </span>
              </p>
              <p className="text-muted-foreground text-xs">
                Need more complex matching logic? Add a Condition step after
                this trigger.
              </p>
            </WebhookConfigSection>
          </div>
        </div>
      )}

      {triggerType === "Schedule" && (
        <>
          <div className="space-y-2">
            <Label className="ml-1" htmlFor="scheduleCron">
              Cron Expression
            </Label>
            <Input
              disabled={disabled}
              id="scheduleCron"
              onChange={(e) => handleScheduleExpressionChange(e.target.value)}
              placeholder="0 9 * * * (every day at 9am)"
              value={scheduleExpression || scheduleCron}
            />
            {parsedCronDescription.description ? (
              <p className="text-muted-foreground text-xs">
                {parsedCronDescription.description}
              </p>
            ) : null}
            {parsedCronDescription.source === "natural-language" &&
            parsedCronDescription.normalizedCron ? (
              <p className="text-muted-foreground text-xs">
                Cron:{" "}
                <code className="font-mono text-[11px]">
                  {parsedCronDescription.normalizedCron}
                </code>
              </p>
            ) : null}
            {parsedCronDescription.error ? (
              <p className="text-destructive text-xs">
                {parsedCronDescription.error}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label className="ml-1" htmlFor="scheduleTimezone">
              Timezone
            </Label>
            <TimezoneSelect
              disabled={disabled}
              id="scheduleTimezone"
              onValueChange={(value) =>
                onUpdateConfig("scheduleTimezone", value)
              }
              value={scheduleTimezone}
            />
          </div>
        </>
      )}
    </>
  );
}
