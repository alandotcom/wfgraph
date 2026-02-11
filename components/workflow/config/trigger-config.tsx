"use client";

import { Clock, Copy, Play, TriangleAlert, Webhook } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TimezoneSelect } from "@/components/ui/timezone-select";
import { getValueByPath } from "@/lib/utils/object-path";
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

function parseCsvEntries(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(entries));
}

function readSchema(config: Record<string, unknown>): SchemaField[] {
  if (typeof config.webhookSchema !== "string" || !config.webhookSchema) {
    return [];
  }

  try {
    const parsed = JSON.parse(config.webhookSchema);
    return Array.isArray(parsed) ? (parsed as SchemaField[]) : [];
  } catch {
    return [];
  }
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

    if (first && typeof first === "object" && !Array.isArray(first)) {
      return {
        name,
        type: "array",
        itemType: "object",
        fields: inferSchemaFromPayload(first as Record<string, unknown>),
      };
    }

    return {
      name,
      type: "array",
      itemType: inferPrimitiveType(first),
    };
  }

  if (value && typeof value === "object") {
    return {
      name,
      type: "object",
      fields: inferSchemaFromPayload(value as Record<string, unknown>),
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
    const currentPath = prefix ? `${prefix}.${field.name}` : field.name;
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Trigger config intentionally combines form, summary, and warnings in one panel.
export function TriggerConfig({
  config,
  onUpdateConfig,
  disabled,
  workflowId,
}: TriggerConfigProps) {
  const webhookUrl = workflowId
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/api/workflows/${workflowId}/webhook`
    : "";

  const eventPath = (config?.webhookEventPath as string) || "event";
  const correlationPath =
    (config?.webhookCorrelationPath as string) || "data.id";
  const createEvents =
    (config?.webhookCreateEvents as string) || "event.create";
  const updateEvents =
    (config?.webhookUpdateEvents as string) || "event.update";
  const deleteEvents =
    (config?.webhookDeleteEvents as string) || "event.delete";
  const mockRequest = (config?.webhookMockRequest as string) || "";
  const schema = readSchema(config);
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
      return { payload: null as unknown, error: "" };
    }

    try {
      return {
        payload: JSON.parse(mockRequest) as unknown,
        error: "",
      };
    } catch {
      return {
        payload: null as unknown,
        error: "Sample payload is not valid JSON.",
      };
    }
  }, [mockRequest]);

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Warning assembly validates multiple independent webhook configuration rules.
  const warnings = useMemo(() => {
    const items: string[] = [];

    if (!eventPath.trim()) {
      items.push("Event type field path is empty.");
    }

    if (!correlationPath.trim()) {
      items.push("Entity ID field path is empty.");
    }

    if (schema.length === 0) {
      items.push(
        "Define a request schema first, then pick routing fields from that schema."
      );
    } else {
      if (eventPath && !schemaPaths.includes(eventPath)) {
        items.push(`Event type field "${eventPath}" is not in request schema.`);
      }

      if (correlationPath && !schemaPaths.includes(correlationPath)) {
        items.push(
          `Entity ID field "${correlationPath}" is not in request schema.`
        );
      }
    }

    const createSet = new Set(parseCsvEntries(createEvents));
    const updateSet = new Set(parseCsvEntries(updateEvents));
    const deleteSet = new Set(parseCsvEntries(deleteEvents));

    if (createSet.size === 0 && updateSet.size === 0 && deleteSet.size === 0) {
      items.push(
        "No events are configured. Incoming webhooks will not start, restart, or stop runs."
      );
    }

    const overlappingCreateUpdate = [...createSet].filter((eventName) =>
      updateSet.has(eventName)
    );
    if (overlappingCreateUpdate.length > 0) {
      items.push(
        `These events appear in both start and restart lists: ${overlappingCreateUpdate.join(", ")}`
      );
    }

    const overlappingCreateDelete = [...createSet].filter((eventName) =>
      deleteSet.has(eventName)
    );
    if (overlappingCreateDelete.length > 0) {
      items.push(
        `These events appear in both start and stop lists: ${overlappingCreateDelete.join(", ")}`
      );
    }

    const overlappingUpdateDelete = [...updateSet].filter((eventName) =>
      deleteSet.has(eventName)
    );
    if (overlappingUpdateDelete.length > 0) {
      items.push(
        `These events appear in both restart and stop lists: ${overlappingUpdateDelete.join(", ")}`
      );
    }

    if (parsedMockRequest.error) {
      items.push(parsedMockRequest.error);
    } else if (parsedMockRequest.payload) {
      const eventValue = getValueByPath(parsedMockRequest.payload, eventPath);
      const correlationValue = getValueByPath(
        parsedMockRequest.payload,
        correlationPath
      );

      if (eventValue === undefined) {
        items.push(`Sample payload is missing event type at "${eventPath}".`);
      }

      if (correlationValue === undefined) {
        items.push(
          `Sample payload is missing entity ID at "${correlationPath}".`
        );
      }

      if (schema.length > 0) {
        const missingSchemaPaths = schemaPaths.filter(
          (path) =>
            getValueByPath(parsedMockRequest.payload, path) === undefined
        );

        if (missingSchemaPaths.length > 0) {
          items.push(
            `Schema fields missing from sample payload: ${missingSchemaPaths.slice(0, 3).join(", ")}${missingSchemaPaths.length > 3 ? ", ..." : ""}`
          );
        }
      }
    }

    return items;
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

  return (
    <>
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="triggerType">
          Trigger Type
        </Label>
        <Select
          disabled={disabled}
          onValueChange={(value) => onUpdateConfig("triggerType", value)}
          value={(config?.triggerType as string) || "Manual"}
        >
          <SelectTrigger className="w-full" id="triggerType">
            <SelectValue placeholder="Select trigger type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="Manual">
              <div className="flex items-center gap-2">
                <Play className="h-4 w-4" />
                Manual
              </div>
            </SelectItem>
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
          </SelectContent>
        </Select>
      </div>

      {config?.triggerType === "Webhook" && (
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
            <SchemaBuilder
              disabled={disabled}
              onChange={(nextSchema) =>
                onUpdateConfig("webhookSchema", JSON.stringify(nextSchema))
              }
              schema={schema}
            />
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

          {warnings.length > 0 && (
            <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
              <div className="flex items-center gap-2">
                <TriangleAlert className="h-4 w-4 text-amber-600" />
                <p className="font-medium text-amber-700 text-sm dark:text-amber-300">
                  Configuration Warnings
                </p>
              </div>
              <div className="space-y-1">
                {warnings.map((warning) => (
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
            <p className="text-muted-foreground text-xs">
              Use this JSON to test trigger behavior without sending a real
              webhook.
            </p>
          </div>
        </div>
      )}

      {config?.triggerType === "Schedule" && (
        <>
          <div className="space-y-2">
            <Label className="ml-1" htmlFor="scheduleCron">
              Cron Expression
            </Label>
            <Input
              disabled={disabled}
              id="scheduleCron"
              onChange={(e) => onUpdateConfig("scheduleCron", e.target.value)}
              placeholder="0 9 * * * (every day at 9am)"
              value={(config?.scheduleCron as string) || ""}
            />
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
              value={(config?.scheduleTimezone as string) || "America/New_York"}
            />
          </div>
        </>
      )}
    </>
  );
}
