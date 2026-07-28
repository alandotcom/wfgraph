import cronstrue from "cronstrue";
import { ChevronDown, Clock, Copy, TriangleAlert, Webhook } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
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
import { getBasePath } from "@/lib/base-path";
import { getRuntimeTriggers } from "@/lib/runtime-extensions";
import type { JsonObject } from "@rova/shared/types/json";
import { cn } from "@rova/shared/utils";
import { getValueByPath } from "@rova/shared/utils/object-path";
import { parseScheduleExpression } from "@rova/shared/utils/schedule-expression";
import {
  policyCanTrigger,
  readRoutingPolicy,
  type RoutingAction,
} from "@rova/shared/workflow/routing-policy";
import { workflowSchemaFieldsToJsonSchemaDocument } from "@rova/shared/workflow/schema-codec";
import { DEFAULT_WEBHOOK_CORRELATION_PATH } from "@rova/shared/workflow/webhook-routing";
import { ActionConfigRenderer } from "./action-config-renderer";
import type { UpdateNodeConfig } from "./node-config-patch";
import { RoutingPolicyEditor } from "./routing-policy-editor";
import { SchemaBuilder } from "./schema-builder";
import {
  flattenSchemaPathOptions,
  inferSchemaFromPayload,
  isSchemaEditorMode,
  parseSchemaJsonEdit,
  readConfigString,
  readWebhookOutputSchema,
  readWebhookRequestSchema,
  type SchemaEditorMode,
  webhookOutputSchemaPatch,
  webhookRequestSchemaPatch,
  webhookSchemaPatchFromSamplePayload,
} from "./webhook-schema";

type TriggerConfigProps = {
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled: boolean;
  workflowId?: string;
};

type WebhookPreset = {
  id: string;
  label: string;
  payload: JsonObject;
};

type WebhookSectionKey =
  | "endpoint"
  | "requestSchema"
  | "outputSchema"
  | "routing"
  | "payload"
  | "summary";

/**
 * The user's explicit open/close choices. A key is absent until the user
 * has toggled that section, so defaults and warning-driven suggestions
 * apply only while the user has expressed no preference.
 */
type WebhookSectionState = Partial<Record<WebhookSectionKey, boolean>>;

const DEFAULT_WEBHOOK_SECTION_STATE: Record<WebhookSectionKey, boolean> = {
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
            <span
              aria-label={`${warningCount} warning${warningCount === 1 ? "" : "s"}`}
              className="inline-flex min-w-5 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 font-medium text-amber-700 text-xs dark:text-amber-200"
            >
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

  // The user copies this into whatever calls the trigger, so it has to name the
  // mount point too. getBasePath() reads it back off the <base href> the server
  // injected.
  const webhookUrl = workflowId
    ? `${typeof window === "undefined" ? "" : window.location.origin}${getBasePath()}/api/workflows/${workflowId}/webhook`
    : "";

  const eventPath = readConfigString(config, "webhookEventPath");
  const correlationPath = readConfigString(
    config,
    "webhookCorrelationPath",
    DEFAULT_WEBHOOK_CORRELATION_PATH
  );
  const routingPolicy = useMemo(() => readRoutingPolicy(config), [config]);
  const mockRequest = readConfigString(config, "webhookMockRequest");
  const scheduleTimezone = readConfigString(
    config,
    "scheduleTimezone",
    "America/New_York"
  );
  const requestSchema = readWebhookRequestSchema(config);
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
    {}
  );
  // The output contract starts hidden: most builders never narrow it, and a
  // stored narrowing (output differing from the request schema) re-opens it.
  const [showOutputSchema, setShowOutputSchema] = useState(
    () => JSON.stringify(outputSchema) !== JSON.stringify(requestSchema)
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
    onUpdateConfig({
      scheduleExpression: value,
      scheduleCron: parseScheduleExpression(value)?.cron ?? value,
    });
  };

  const { configWarnings, payloadWarnings } = useMemo(() => {
    const configItems: string[] = [];
    const payloadItems: string[] = [];

    // A trigger with no request schema is work not yet started, not work
    // done wrong: the panel stays quiet until there is something to check.
    // The routing section's own helper text says what to do first.
    if (requestSchema.length > 0) {
      if (!eventPath.trim()) {
        configItems.push("The Event Type field is empty.");
      }

      if (!correlationPath.trim()) {
        configItems.push("The Correlation Key field is empty.");
      }

      if (eventPath && !schemaPaths.includes(eventPath)) {
        configItems.push(
          `Event Type field "${eventPath}" is not in the request schema.`
        );
      }

      if (correlationPath && !schemaPaths.includes(correlationPath)) {
        configItems.push(
          `Correlation Key field "${correlationPath}" is not in the request schema.`
        );
      }

      if (!policyCanTrigger(routingPolicy)) {
        configItems.push(
          "No event type is mapped to Start or Replace, so this workflow can never be triggered."
        );
      }
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
          `Sample payload has no Event Type at "${eventPath}".`
        );
      }

      if (correlationValue === undefined) {
        payloadItems.push(
          `Sample payload has no Correlation Key at "${correlationPath}".`
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
    eventPath,
    parsedMockRequest.error,
    parsedMockRequest.payload,
    requestSchema,
    routingPolicy,
    schemaPaths,
  ]);

  const setWebhookSectionOpen = (section: WebhookSectionKey, open: boolean) => {
    setWebhookSections((prev) => {
      if (prev[section] === open) {
        return prev;
      }

      return { ...prev, [section]: open };
    });
  };
  // Warnings suggest an open section; a user's explicit choice wins. An OR
  // here would turn the header into a dead control whenever warnings exist.
  const sectionUserChoice = (section: WebhookSectionKey) =>
    webhookSections[section];
  const routingSectionOpen =
    sectionUserChoice("routing") ??
    (DEFAULT_WEBHOOK_SECTION_STATE.routing || configWarnings.length > 0);
  const payloadSectionOpen =
    sectionUserChoice("payload") ??
    (DEFAULT_WEBHOOK_SECTION_STATE.payload || payloadWarnings.length > 0);

  const handleCopyWebhookUrl = () => {
    if (webhookUrl) {
      void navigator.clipboard.writeText(webhookUrl);
      toast.success("Webhook URL copied to clipboard");
    }
  };

  // Whether the stored schema still matches what the sample payload implies.
  // Inference only overwrites an EMPTY schema on its own; a schema someone
  // built by hand (field types, descriptions) is only replaced through the
  // explicit sync button below.
  const inferredSchemaFromPayload = useMemo(
    () =>
      parsedMockRequest.payload
        ? inferSchemaFromPayload(parsedMockRequest.payload)
        : undefined,
    [parsedMockRequest.payload]
  );
  const schemaOutOfSyncWithPayload =
    requestSchema.length > 0 &&
    inferredSchemaFromPayload !== undefined &&
    JSON.stringify(inferredSchemaFromPayload) !== JSON.stringify(requestSchema);

  const handleSyncSchemaFromPayload = () => {
    if (!inferredSchemaFromPayload) {
      return;
    }
    onUpdateConfig(webhookRequestSchemaPatch(inferredSchemaFromPayload));
    toast.success("Schema replaced from sample payload");
  };

  const handleLoadPreset = (preset: WebhookPreset) => {
    const schemaIsEmpty = requestSchema.length === 0;
    onUpdateConfig({
      webhookMockRequest: JSON.stringify(preset.payload, null, 2),
      ...(schemaIsEmpty
        ? webhookRequestSchemaPatch(inferSchemaFromPayload(preset.payload))
        : {}),
    });

    toast.success(
      schemaIsEmpty
        ? `${preset.label} example loaded (schema synced)`
        : `${preset.label} example loaded`
    );
  };

  const handleRequestSchemaJsonChange = (nextValue: string) => {
    setRequestSchemaJsonDraft(nextValue);

    const edit = parseSchemaJsonEdit(nextValue);
    if (!edit.ok) {
      setRequestSchemaJsonError(edit.error);
      return;
    }

    onUpdateConfig(webhookRequestSchemaPatch(edit.schema));
    setRequestSchemaJsonError("");
  };

  const handleOutputSchemaJsonChange = (nextValue: string) => {
    setOutputSchemaJsonDraft(nextValue);

    const edit = parseSchemaJsonEdit(nextValue);
    if (!edit.ok) {
      setOutputSchemaJsonError(edit.error);
      return;
    }

    onUpdateConfig(webhookOutputSchemaPatch(edit.schema));
    setOutputSchemaJsonError("");
  };

  return (
    <>
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="triggerType">
          Trigger Type
        </Label>
        <Select
          disabled={disabled}
          onValueChange={(value) => onUpdateConfig({ triggerType: value })}
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
              <p className="font-medium text-sm">Configuration</p>
              <ActionConfigRenderer
                config={config}
                disabled={disabled}
                fields={selectedRuntimeTrigger?.configFields ?? []}
                onUpdateConfig={onUpdateConfig}
              />
            </div>
          )}

          <div className="space-y-3 rounded-md border bg-background p-3">
            <div className="space-y-1">
              <p className="font-medium text-sm">Routing Policy</p>
              <p className="text-muted-foreground text-xs">
                Choose what each event type does when it arrives. Unmapped event
                types are ignored, though they can still resume a waiting run.
              </p>
            </div>
            <RoutingPolicyEditor
              disabled={disabled}
              eventTypes={selectedRuntimeTrigger?.eventTypes}
              onChange={(nextPolicy) =>
                onUpdateConfig({ routingPolicy: nextPolicy })
              }
              policy={routingPolicy}
            />
            {selectedRuntimeTrigger?.correlationPath ? (
              <p className="text-muted-foreground text-xs">
                Runs are correlated by{" "}
                <code className="font-mono text-xs">
                  {selectedRuntimeTrigger.correlationPath}
                </code>
                : Replace and Cancel act on runs whose value matches, and Waits
                resume on them.
              </p>
            ) : null}
          </div>
        </div>
      )}

      {triggerType === "Webhook" && (
        <div className="overflow-hidden rounded-md border">
          <div className="p-2">
            <WebhookConfigSection
              description="The URL your service posts events to."
              onOpenChange={(open) => setWebhookSectionOpen("endpoint", open)}
              open={
                sectionUserChoice("endpoint") ??
                DEFAULT_WEBHOOK_SECTION_STATE.endpoint
              }
              title="Webhook Endpoint"
            >
              <div className="space-y-2">
                <Label className="ml-1" htmlFor="webhookUrl">
                  Webhook URL
                </Label>
                {webhookUrl ? (
                  <div className="flex gap-2">
                    <Input
                      className="font-mono text-xs"
                      id="webhookUrl"
                      readOnly
                      value={webhookUrl}
                    />
                    <Button
                      aria-label="Copy webhook URL"
                      onClick={handleCopyWebhookUrl}
                      size="icon"
                      type="button"
                      variant="outline"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs" id="webhookUrl">
                    Save the workflow to generate its webhook URL.
                  </p>
                )}
              </div>
            </WebhookConfigSection>
          </div>

          <Separator />

          <div className="p-2">
            <WebhookConfigSection
              description="The fields incoming payloads carry. Paste a sample payload below to fill this in automatically."
              onOpenChange={(open) =>
                setWebhookSectionOpen("requestSchema", open)
              }
              open={
                sectionUserChoice("requestSchema") ??
                DEFAULT_WEBHOOK_SECTION_STATE.requestSchema
              }
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
                      onUpdateConfig(webhookRequestSchemaPatch(nextSchema))
                    }
                    schema={requestSchema}
                  />
                </TabsContent>
                <TabsContent className="space-y-3" value="json">
                  <div className="overflow-hidden rounded-md border">
                    <CodeEditor
                      aria-label="Request schema JSON"
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

              {/* The output contract is a narrowing of the request schema,
                  and editing the request schema resets it. Rendering it as a
                  subordinate disclosure (rather than a sibling section) is
                  what makes that dependency legible. */}
              <div className="space-y-2 border-t pt-3">
                <p className="text-muted-foreground text-xs">
                  Downstream steps receive every request field.{" "}
                  {showOutputSchema ? null : (
                    <button
                      className="font-medium text-foreground underline underline-offset-2"
                      onClick={() => setShowOutputSchema(true)}
                      type="button"
                    >
                      Narrow the output contract
                    </button>
                  )}
                </p>
                {showOutputSchema ? (
                  <div className="space-y-3 rounded-md border bg-muted/30 p-3">
                    <p className="text-muted-foreground text-xs">
                      Editing the request schema above resets this to match.
                    </p>
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
                            onUpdateConfig(webhookOutputSchemaPatch(nextSchema))
                          }
                          schema={outputSchema}
                        />
                      </TabsContent>
                      <TabsContent className="space-y-3" value="json">
                        <div className="overflow-hidden rounded-md border">
                          <CodeEditor
                            aria-label="Output contract JSON"
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
                  </div>
                ) : null}
              </div>
            </WebhookConfigSection>
          </div>

          <Separator />

          <div className="p-2">
            <WebhookConfigSection
              description="What each event type does: start a run, replace this entity's runs, cancel them, or ignore it."
              onOpenChange={(open) => setWebhookSectionOpen("routing", open)}
              open={routingSectionOpen}
              title="Routing Policy"
              warningCount={configWarnings.length}
            >
              <div className="space-y-2">
                <Label htmlFor="guidedEventPath">Event Type field</Label>
                <Select
                  disabled={disabled || schemaPathOptions.length === 0}
                  onValueChange={(value) => {
                    setWebhookSectionOpen("routing", true);
                    onUpdateConfig({ webhookEventPath: value });
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
                        label={option.path}
                        value={option.path}
                      >
                        <span className="flex items-baseline gap-2">
                          {option.path}
                          {option.type ? (
                            <span className="text-muted-foreground text-xs">
                              {option.type}
                            </span>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  The payload field naming what happened — a string field like{" "}
                  <code>event</code> or <code>meta.action</code>.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="guidedCorrelationPath">
                  Correlation Key field
                </Label>
                <Select
                  disabled={disabled || schemaPathOptions.length === 0}
                  onValueChange={(value) => {
                    setWebhookSectionOpen("routing", true);
                    onUpdateConfig({ webhookCorrelationPath: value });
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
                        label={option.path}
                        value={option.path}
                      >
                        <span className="flex items-baseline gap-2">
                          {option.path}
                          {option.type ? (
                            <span className="text-muted-foreground text-xs">
                              {option.type}
                            </span>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  Runs sharing this value are about the same entity: Replace and
                  Cancel act on them, and Waits resume on them. Defaults to{" "}
                  <code>data.id</code>.
                </p>
              </div>

              <div className="space-y-2">
                <p className="font-medium text-sm">Event Types</p>
                <RoutingPolicyEditor
                  disabled={disabled}
                  eventTypes={undefined}
                  onChange={(nextPolicy) => {
                    setWebhookSectionOpen("routing", true);
                    onUpdateConfig({ routingPolicy: nextPolicy });
                  }}
                  policy={routingPolicy}
                  showTriggerabilityWarning={false}
                />
                <p className="text-muted-foreground text-xs">
                  Values arriving at the Event Type field above. An event type
                  without a row is ignored, though it can still resume a waiting
                  run.
                </p>
              </div>

              {schemaPathOptions.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  Start with the request schema above (or paste a sample payload
                  below) — the two fields here pick from its paths.
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
              description="Paste a real payload to build the schema and check your fields against it."
              onOpenChange={(open) => setWebhookSectionOpen("payload", open)}
              open={payloadSectionOpen}
              title="Sample Payload"
              warningCount={payloadWarnings.length}
            >
              <Label htmlFor="webhookMockRequest">Sample Payload</Label>
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
                  id="webhookMockRequest"
                  onChange={(value) => {
                    // Only an empty schema is filled in automatically; a
                    // hand-built one is replaced solely through the explicit
                    // sync button below, never by typing here.
                    setWebhookSectionOpen("payload", true);
                    onUpdateConfig({
                      webhookMockRequest: value || "",
                      ...(requestSchema.length === 0
                        ? webhookSchemaPatchFromSamplePayload(value || "")
                        : {}),
                    });
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
              {schemaOutOfSyncWithPayload ? (
                <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-2">
                  <p className="text-muted-foreground text-xs">
                    This payload's shape differs from the request schema.
                  </p>
                  <Button
                    disabled={disabled}
                    onClick={handleSyncSchemaFromPayload}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Sync schema from payload
                  </Button>
                </div>
              ) : null}
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
              description="What the current policy does with incoming events."
              onOpenChange={(open) => setWebhookSectionOpen("summary", open)}
              open={
                sectionUserChoice("summary") ??
                DEFAULT_WEBHOOK_SECTION_STATE.summary
              }
              title="Behavior Summary"
            >
              {/* One definition per action, shared with the policy table's
                  dropdown; two phrasings of Replace would read as two
                  different behaviors. */}
              {(
                [
                  ["start", "Start a new run"],
                  [
                    "replace",
                    "Cancel this entity's runs, then start a new one",
                  ],
                  ["cancel", "Cancel this entity's runs"],
                ] satisfies Array<[RoutingAction, string]>
              ).map(([action, label]) => {
                const mapped = Object.entries(routingPolicy ?? {})
                  .filter(([, rowAction]) => rowAction === action)
                  .map(([eventType]) => eventType);
                return (
                  <p className="text-sm" key={action}>
                    {label}:{" "}
                    <span className="font-mono text-xs">
                      {mapped.length > 0 ? mapped.join(", ") : "(none)"}
                    </span>
                  </p>
                );
              })}
              <p className="text-muted-foreground text-xs">
                Every other event type is ignored, though it can still resume a
                waiting run. Need more complex matching logic? Add a Condition
                step after this trigger.
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
                <code className="font-mono text-xs">
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
                onUpdateConfig({ scheduleTimezone: value })
              }
              value={scheduleTimezone}
            />
          </div>
        </>
      )}
    </>
  );
}
