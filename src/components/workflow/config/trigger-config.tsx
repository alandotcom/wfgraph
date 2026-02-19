import cronstrue from "cronstrue";
import { Clock, Copy, TriangleAlert, Webhook } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { getRuntimeTriggers } from "@/client/lib/runtime-extensions";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TimezoneSelect } from "@/components/ui/timezone-select";
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
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
  workflowId?: string;
};

type WebhookPreset = {
  id: string;
  label: string;
  payload: Record<string, unknown>;
};

type SchemaEditorMode = "builder" | "json";

const WEBHOOK_PRESETS: WebhookPreset[] = [
  {
    id: "appointment-created",
    label: "Appointment Created",
    payload: {
      event: "event.create",
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
    id: "appointment-updated",
    label: "Appointment Updated",
    payload: {
      event: "event.update",
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
    id: "appointment-deleted",
    label: "Appointment Deleted",
    payload: {
      event: "event.delete",
      timestamp: "2026-02-11T20:00:00Z",
      data: {
        id: "appt_123",
        status: "cancelled",
      },
    },
  },
];

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

function readSchema(config: Record<string, unknown>): SchemaField[] {
  if (typeof config.webhookSchema !== "string" || !config.webhookSchema) {
    return [];
  }

  try {
    const parsed = JSON.parse(config.webhookSchema);
    return parseWorkflowSchemaFieldsOrJsonSchema(parsed) ?? [];
  } catch {
    return [];
  }
}

function isSchemaEditorMode(value: string): value is SchemaEditorMode {
  return value === "builder" || value === "json";
}

function inferPrimitiveType(value: unknown): "string" | "number" | "boolean" {
  if (typeof value === "number") {
    return "number";
  }

  if (typeof value === "boolean") {
    return "boolean";
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

function toConfigString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Trigger config intentionally combines form, summary, and warnings in one panel.
export function TriggerConfig({
  config,
  onUpdateConfig,
  disabled,
  workflowId,
}: TriggerConfigProps) {
  const [schemaEditorMode, setSchemaEditorMode] =
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

  const eventPath = readConfigString(config, "webhookEventPath", "event");
  const correlationPath = readConfigString(
    config,
    "webhookCorrelationPath",
    "data.id"
  );
  const createEvents = readConfigString(
    config,
    "webhookCreateEvents",
    "event.create"
  );
  const updateEvents = readConfigString(
    config,
    "webhookUpdateEvents",
    "event.update"
  );
  const deleteEvents = readConfigString(
    config,
    "webhookDeleteEvents",
    "event.delete"
  );
  const mockRequest = readConfigString(config, "webhookMockRequest");
  const scheduleTimezone = readConfigString(
    config,
    "scheduleTimezone",
    "America/New_York"
  );
  const schema = readSchema(config);
  const schemaJsonValue = useMemo(
    () =>
      JSON.stringify(workflowSchemaFieldsToJsonSchemaDocument(schema), null, 2),
    [schema]
  );
  const [schemaJsonDraft, setSchemaJsonDraft] = useState(schemaJsonValue);
  const [schemaJsonError, setSchemaJsonError] = useState("");

  const schemaPathOptions = useMemo(
    () => flattenSchemaPathOptions(schema),
    [schema]
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

    if (schema.length === 0) {
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

      if (schema.length > 0) {
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
    schema,
    schemaPaths,
    updateEvents,
  ]);

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

    toast.success(`${preset.label} example loaded (schema synced)`);
  };

  const handleCustomTriggerConfigUpdate = (key: string, value: unknown) => {
    onUpdateConfig(key, toConfigString(value));
  };

  const handleSchemaJsonChange = (nextValue: string) => {
    setSchemaJsonDraft(nextValue);

    if (!nextValue.trim()) {
      onUpdateConfig("webhookSchema", "");
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

      onUpdateConfig("webhookSchema", JSON.stringify(parsedSchema));
      setSchemaJsonError("");
    } catch {
      setSchemaJsonError("Schema is not valid JSON.");
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
        <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
          <div className="space-y-1">
            <p className="font-medium text-sm">Webhook Configuration</p>
            <p className="text-muted-foreground text-xs">
              Define how incoming events should start, restart, or stop runs.
            </p>
          </div>

          <div className="space-y-2 rounded-md border bg-background p-3">
            <Label className="ml-1">Webhook URL</Label>
            <div className="flex gap-2">
              <Input
                className="font-mono text-xs"
                disabled
                value={webhookUrl || "Save workflow to generate webhook URL"}
              />
              <Button
                disabled={!webhookUrl}
                onClick={handleCopyWebhookUrl}
                size="icon"
                variant="outline"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="space-y-3 rounded-md border bg-background p-3">
            <p className="font-medium text-xs uppercase tracking-wide">
              Request Schema
            </p>
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
              <TabsList className="w-fit">
                <TabsTrigger value="builder">Builder</TabsTrigger>
                <TabsTrigger value="json">JSON Schema</TabsTrigger>
              </TabsList>
              <TabsContent className="space-y-3" value="builder">
                <SchemaBuilder
                  disabled={disabled}
                  onChange={(nextSchema) =>
                    onUpdateConfig("webhookSchema", JSON.stringify(nextSchema))
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
                    <p className="text-destructive text-xs">
                      {schemaJsonError}
                    </p>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      Changes auto-apply when JSON is valid. Supports top-level
                      JSON Schema <code>properties</code>.
                    </p>
                  )}
                </div>
              </TabsContent>
            </Tabs>
            <p className="text-muted-foreground text-xs">
              Define your webhook contract once. Routing fields and autocomplete
              both read from this schema.
            </p>
          </div>

          <div className="space-y-3 rounded-md border bg-background p-3">
            <p className="font-medium text-xs uppercase tracking-wide">
              Routing Rules
            </p>

            <div className="space-y-2">
              <Label htmlFor="guidedEventPath">
                Which schema field contains the event value?
              </Label>
              <Select
                disabled={disabled || schemaPathOptions.length === 0}
                onValueChange={(value) =>
                  onUpdateConfig("webhookEventPath", value)
                }
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
                This must point to a string field in your schema, such as{" "}
                <code>type</code> or <code>meta.action</code>.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="guidedCorrelationPath">
                Which schema field identifies the entity?
              </Label>
              <Select
                disabled={disabled || schemaPathOptions.length === 0}
                onValueChange={(value) =>
                  onUpdateConfig("webhookCorrelationPath", value)
                }
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
                Runs with the same value here are cancelled or resumed together.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="guidedCreateEvents">
                Values that start a run
              </Label>
              <Input
                disabled={disabled}
                id="guidedCreateEvents"
                onChange={(e) =>
                  onUpdateConfig("webhookCreateEvents", e.target.value)
                }
                placeholder="event.create"
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
                onChange={(e) =>
                  onUpdateConfig("webhookUpdateEvents", e.target.value)
                }
                placeholder="event.update"
                value={updateEvents}
              />
              <p className="text-muted-foreground text-xs">
                Matching waiting runs are cancelled first, then a new run
                starts.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="guidedDeleteEvents">Values that stop runs</Label>
              <Input
                disabled={disabled}
                id="guidedDeleteEvents"
                onChange={(e) =>
                  onUpdateConfig("webhookDeleteEvents", e.target.value)
                }
                placeholder="event.delete"
                value={deleteEvents}
              />
              <p className="text-muted-foreground text-xs">
                Matching waiting runs are cancelled and no new run is created.
              </p>
            </div>

            {schemaPathOptions.length === 0 && (
              <p className="text-muted-foreground text-xs">
                Add schema properties above to enable routing field selection.
              </p>
            )}
          </div>

          <div className="space-y-2 rounded-md border bg-background p-3">
            <p className="font-medium text-xs uppercase tracking-wide">
              Behavior Summary
            </p>
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
              Need more complex matching logic? Add a Condition step after this
              trigger.
            </p>
          </div>

          {configWarnings.length > 0 && (
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
          )}

          <div className="space-y-2 rounded-md border bg-background p-3">
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
                onChange={(value) =>
                  onUpdateConfig("webhookMockRequest", value || "")
                }
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
            <p className="text-muted-foreground text-xs">
              Use this JSON to test trigger behavior without sending a real
              webhook.
            </p>
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
