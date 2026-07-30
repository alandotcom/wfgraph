import { ChevronDown } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "#src/components/ui/button";
import { CodeEditor } from "#src/components/ui/code-editor";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#src/components/ui/collapsible";
import { Label } from "#src/components/ui/label";
import { Separator } from "#src/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "#src/components/ui/tabs";
import type { JsonObject } from "@rova/shared/types/json";
import { cn } from "@rova/shared/utils";
import { getValueByPath } from "@rova/shared/utils/object-path";
import { workflowSchemaFieldsToJsonSchemaDocument } from "@rova/shared/workflow/schema-codec";
import type { UpdateNodeConfig } from "./node-config-patch";
import { SchemaBuilder } from "./schema-builder";
import {
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

type LifecycleNodeConfigProps = {
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled: boolean;
};

type WebhookPreset = {
  id: string;
  label: string;
  payload: JsonObject;
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

/**
 * The Lifecycle Node's payload shape: what a run receives, and a sample to try one
 * against.
 *
 * The rules themselves are `LifecyclePanel`, mounted beside this one rather than
 * inside it: the two answer different questions, and nesting them made the panel
 * that matters a detail of the one B5 deletes.
 */
export function LifecycleNodeConfig({
  config,
  onUpdateConfig,
  disabled,
}: LifecycleNodeConfigProps) {
  const [requestSchemaEditorMode, setRequestSchemaEditorMode] =
    useState<SchemaEditorMode>("builder");
  const [outputSchemaEditorMode, setOutputSchemaEditorMode] =
    useState<SchemaEditorMode>("builder");
  const mockRequest = readConfigString(config, "webhookMockRequest");
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
  // Two sections, two booleans. The schema starts open because it is what a
  // builder came for; the payload starts closed unless something is wrong with it,
  // and once the builder has touched either header their choice is what holds.
  const [schemaSectionOpen, setSchemaSectionOpen] = useState(true);
  const [payloadSectionChoice, setPayloadSectionChoice] = useState<
    boolean | undefined
  >(undefined);
  // The output contract starts hidden: most builders never narrow it, and a
  // stored narrowing (output differing from the request schema) re-opens it.
  const [showOutputSchema, setShowOutputSchema] = useState(
    () => JSON.stringify(outputSchema) !== JSON.stringify(requestSchema)
  );

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

  /** What is wrong with the sample payload, as one sentence or none. */
  const payloadWarning = useMemo(() => {
    if (parsedMockRequest.error) {
      return parsedMockRequest.error;
    }
    if (!(parsedMockRequest.payload && requestSchema.length > 0)) {
      return "";
    }

    const missing = requestSchema
      .map((field) => field.name)
      .filter(
        (path) => getValueByPath(parsedMockRequest.payload, path) === undefined
      );

    return missing.length > 0
      ? `Schema fields missing from sample payload: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", ..." : ""}`
      : "";
  }, [parsedMockRequest.error, parsedMockRequest.payload, requestSchema]);

  // A warning suggests the section; the builder's own choice wins. An OR here
  // would turn the header into a dead control whenever a warning existed.
  const payloadSectionOpen = payloadSectionChoice ?? payloadWarning !== "";

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
    <div className="overflow-hidden rounded-md border">
      <div className="p-2">
        <WebhookConfigSection
          description="The fields incoming payloads carry. Paste a sample payload below to fill this in automatically."
          onOpenChange={setSchemaSectionOpen}
          open={schemaSectionOpen}
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
                    Changes auto-apply when JSON is valid. Supports top-level
                    JSON Schema <code>properties</code>.
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
          description="Paste a real payload to build the schema and check your fields against it."
          onOpenChange={setPayloadSectionChoice}
          open={payloadSectionOpen}
          title="Sample Payload"
          warningCount={payloadWarning === "" ? 0 : 1}
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
                setPayloadSectionChoice(true);
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
            {payloadWarning === "" ? null : (
              <p className="text-amber-700 text-xs dark:text-amber-200">
                {payloadWarning}
              </p>
            )}
          </div>
        </WebhookConfigSection>
      </div>
    </div>
  );
}
