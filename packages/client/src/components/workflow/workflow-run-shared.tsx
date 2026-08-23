import { Check, ChevronRight, Copy } from "lucide-react";
import { Schema } from "effect";
import { type ComponentType, useState } from "react";
import type { IntegrationUi, ResultComponentProps } from "@wfgraph/plugins/ui";
import { Button } from "#src/components/ui/button";
import { useIntegrationUi } from "#src/components/integration-ui-provider";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { getClientLogger } from "#src/lib/logger";
import { cn } from "@wfgraph/shared/utils";
import {
  type ActionMetadata,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import type { WorkflowExecutionStatus } from "@wfgraph/shared/lifecycle/execution-contracts";
import { type JsonValue, readJsonValue } from "@wfgraph/shared/types/json";
import { readAs } from "@wfgraph/shared/types/schema";

/**
 * How a status reads on screen, for the two vocabularies that reach these.
 *
 * An Execution ends `completed`, `failed`, `canceled` or `superseded`; a node
 * inside one ends `success`, `error` or `cancelled`. Both arrive here as strings
 * off a payload, so the lookups are records rather than switches and `satisfies`
 * is what holds each to naming every member of its own union.
 */
const logger = getClientLogger("workflow", "run");

const RUN_STATUS_TONES = {
  pending: "muted",
  running: "info",
  waiting: "pending",
  completed: "good",
  canceled: "quiet",
  superseded: "quiet",
  failed: "bad",
} satisfies Record<WorkflowExecutionStatus, StatusTone>;

const NODE_STATUS_TONES = {
  pending: "muted",
  running: "info",
  success: "good",
  error: "bad",
  cancelled: "quiet",
} satisfies Record<NodeStatus, StatusTone>;

type StatusTone = "good" | "bad" | "info" | "pending" | "quiet" | "muted";

/** A node's own statuses, which the engine writes and the canvas draws. */
type NodeStatus = "pending" | "running" | "success" | "error" | "cancelled";

function toneOf(status: string): StatusTone {
  return (
    (RUN_STATUS_TONES as Record<string, StatusTone | undefined>)[status] ??
    (NODE_STATUS_TONES as Record<string, StatusTone | undefined>)[status] ??
    "muted"
  );
}

const DOT_CLASSES: Record<StatusTone, string> = {
  good: "bg-success",
  bad: "bg-destructive",
  info: "bg-info",
  pending: "bg-warning",
  quiet: "bg-cancelled",
  muted: "bg-muted-foreground",
};

/**
 * How each status reads, keyed by the status rather than by its tone.
 *
 * Colour is shared between the two vocabularies and wording is not: a displaced
 * run and a cancelled one are both quiet, and calling the first "Cancelled"
 * sends a builder looking for who cancelled it. Keying the words to the status
 * makes a new one a compile error here instead of a silent "Unknown".
 */
const RUN_STATUS_LABELS = {
  pending: "Pending",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  canceled: "Canceled",
  superseded: "Superseded",
  failed: "Failed",
} satisfies Record<WorkflowExecutionStatus, string>;

const NODE_STATUS_LABELS = {
  pending: "Pending",
  running: "Running",
  success: "Success",
  error: "Error",
  cancelled: "Cancelled",
} satisfies Record<NodeStatus, string>;

const BADGE_CLASSES: Record<StatusTone, string> = {
  good: "border-success/30 bg-success/10 text-success",
  bad: "border-destructive/30 bg-destructive/10 text-destructive",
  info: "border-info/30 bg-info/10 text-info",
  pending: "border-warning/30 bg-warning/10 text-warning",
  quiet: "border-cancelled/30 bg-cancelled/10 text-cancelled",
  muted: "border-muted bg-muted/40 text-muted-foreground",
};

export function getStatusDotClass(status: string): string {
  return DOT_CLASSES[toneOf(status)];
}

export function getStatusLabel(status: string): string {
  return (
    (RUN_STATUS_LABELS as Record<string, string | undefined>)[status] ??
    (NODE_STATUS_LABELS as Record<string, string | undefined>)[status] ??
    "Unknown"
  );
}

export function getStatusBadgeClass(status: string): string {
  return BADGE_CLASSES[toneOf(status)];
}

const TEXT_CLASSES: Record<StatusTone, string> = {
  good: "text-success",
  bad: "text-destructive",
  info: "text-info",
  pending: "text-warning",
  quiet: "text-cancelled",
  muted: "text-muted-foreground",
};

export function getStatusTextClass(status: string): string {
  return TEXT_CLASSES[toneOf(status)];
}

export function nodeKindLabel(nodeType: string): string {
  switch (nodeType) {
    case "lifecycle":
      return "Lifecycle";
    case "wait":
      return "Wait";
    case "condition":
      return "Condition";
    case "group":
      return "Group";
    default:
      return "Action";
  }
}

export function formatDuration(duration: string): string {
  if (!/^\d+$/.test(duration)) {
    return duration;
  }
  const ms = Number.parseInt(duration, 10);
  return ms < 1000 ? `${duration}ms` : `${(ms / 1000).toFixed(2)}s`;
}

// Data helpers

/**
 * Step output carrying an image inline as base64. Also read from a stored step
 * log, so it is parsed too. The length floor keeps a short string that happens to
 * be named `base64` out of an image tag's src.
 */
const readBase64Image = readAs(
  Schema.Struct({
    base64: Schema.String.check(Schema.isMinLength(101)),
  })
);

export function readBase64ImageOutput(output: unknown): string | null {
  return readBase64Image(output)?.base64 ?? null;
}

// URL detection helper
function isUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Shared UI components

export function JsonWithLinks({ data }: { data: unknown }) {
  const jsonString = JSON.stringify(data, null, 2);
  const parts = jsonString.split(/("https?:\/\/[^"]+"|"[^"]*")/g);

  return (
    <>
      {parts.map((part) => {
        if (part.startsWith('"') && part.endsWith('"')) {
          const innerValue = part.slice(1, -1);
          if (isUrl(innerValue)) {
            return (
              <a
                className="text-info underline underline-offset-2 hover:text-info/80"
                href={innerValue}
                key={innerValue}
                rel="noopener noreferrer"
                target="_blank"
              >
                {part}
              </a>
            );
          }
        }
        return part;
      })}
    </>
  );
}

export function CopyButton({
  data,
  isError = false,
}: {
  data: unknown;
  isError?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const text = isError ? String(data) : JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      logger.error("Failed to copy the run payload", { error });
    }
  };

  return (
    <Button
      aria-label="Copy"
      className="max-md:size-11"
      onClick={handleCopy}
      size="icon-sm"
      type="button"
      variant="ghost"
    >
      {copied ? (
        <Check className="size-3 text-success" />
      ) : (
        <Copy className="size-3" />
      )}
    </Button>
  );
}

export function CollapsibleSection({
  title,
  children,
  defaultExpanded = false,
  copyData,
  isError = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  copyData?: unknown;
  isError?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultExpanded);

  return (
    <div>
      <div className="mb-2 flex w-full items-center justify-between">
        <button
          aria-expanded={isOpen}
          className="flex min-h-11 items-center gap-1.5 rounded-sm px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 md:min-h-9"
          onClick={() => setIsOpen((current) => !current)}
          type="button"
        >
          <ChevronRight
            className={cn(
              "size-3 text-muted-foreground transition-transform duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
              isOpen && "rotate-90"
            )}
          />
          <span className="font-medium text-muted-foreground text-sm">
            {title}
          </span>
        </button>
        <div className="flex items-center gap-1">
          {copyData !== undefined ? (
            <CopyButton data={copyData} isError={isError} />
          ) : null}
        </div>
      </div>
      {isOpen ? (
        <div className="motion-safe:animate-[run-disclosure_160ms_cubic-bezier(0.16,1,0.3,1)] motion-reduce:animate-[run-panel-fade_100ms_ease-out]">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The custom renderer for an action's output, or undefined when its output is
 * shown as plain JSON.
 *
 * The catalog entry names the owning integration and the id is only how you find
 * it: a host may legally define an action called `slack/notify`, and that action
 * must not pick up Slack's renderer for output Slack knows nothing about.
 */
function findOutputComponent(
  integrationUi: Record<string, IntegrationUi>,
  action: ActionMetadata | undefined
): ComponentType<ResultComponentProps> | undefined {
  const owner = action?.integration;
  if (!owner) {
    return undefined;
  }

  const prefix = `${owner}/`;
  if (!action.id.startsWith(prefix)) {
    return undefined;
  }

  return integrationUi[owner]?.outputComponents?.[
    action.id.slice(prefix.length)
  ];
}

export const JSON_PRE_CLASS =
  "min-w-max whitespace-pre p-3 font-mono text-[0.8125rem] leading-relaxed";

const UPPERCASE_KEY_WORDS = new Set([
  "api",
  "http",
  "https",
  "id",
  "uri",
  "url",
]);

function humanizeKey(key: string): string {
  return key
    .replaceAll(/[_-]+/g, " ")
    .replaceAll(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .map((word) => {
      const lower = word.toLowerCase();
      if (UPPERCASE_KEY_WORDS.has(lower)) {
        return lower.toUpperCase();
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function ScalarValue({ value }: { value: string | number | boolean | null }) {
  if (value === null || value === "") {
    return <span className="text-muted-foreground italic">Empty</span>;
  }
  if (typeof value === "boolean") {
    return <span>{value ? "Yes" : "No"}</span>;
  }
  if (typeof value === "number") {
    return <span className="font-mono tabular-nums">{value}</span>;
  }
  if (isUrl(value)) {
    return (
      <a
        className="break-all text-info underline underline-offset-2 hover:text-info/80"
        href={value}
        rel="noopener noreferrer"
        target="_blank"
      >
        {value}
      </a>
    );
  }
  return <span className="break-words">{value}</span>;
}

function isScalar(value: JsonValue): value is string | number | boolean | null {
  return value === null || typeof value !== "object";
}

function areScalars(
  values: JsonValue[]
): values is Array<string | number | boolean | null> {
  return values.every(isScalar);
}

function withJsonKeys<Value extends JsonValue>(values: Value[]) {
  const occurrences = new Map<string, number>();
  return values.map((value) => {
    const serialized = JSON.stringify(value);
    const occurrence = (occurrences.get(serialized) ?? 0) + 1;
    occurrences.set(serialized, occurrence);
    return { key: `${serialized}:${occurrence}`, value };
  });
}

function JsonFields({ value }: { value: { [key: string]: JsonValue } }) {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return <span className="text-muted-foreground text-xs italic">Empty</span>;
  }

  return (
    <dl className="divide-y divide-border/70 border-y">
      {entries.map(([key, fieldValue]) => (
        <JsonProperty key={key} label={humanizeKey(key)} value={fieldValue} />
      ))}
    </dl>
  );
}

function CollectionDisclosure({
  label,
  summary,
  children,
}: {
  label: string;
  summary: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-t first:border-t-0">
      <button
        aria-expanded={open}
        className="grid min-h-11 w-full grid-cols-[minmax(5.5rem,0.85fr)_minmax(0,1.15fr)] items-center gap-3 py-2 text-left transition-colors duration-100 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 md:min-h-9"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="text-muted-foreground text-xs">{label}</span>
        <span className="flex min-w-0 items-center justify-between gap-2 text-xs">
          <span>{summary}</span>
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
              open && "rotate-90"
            )}
          />
        </span>
      </button>
      {open ? (
        <div className="border-t bg-muted/20 py-1 pl-3 motion-safe:animate-[run-disclosure_160ms_cubic-bezier(0.16,1,0.3,1)] motion-reduce:animate-[run-panel-fade_100ms_ease-out]">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function JsonProperty({ label, value }: { label: string; value: JsonValue }) {
  if (isScalar(value)) {
    return (
      <div className="grid min-h-9 grid-cols-[minmax(5.5rem,0.85fr)_minmax(0,1.15fr)] items-start gap-3 py-2 text-xs">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="min-w-0">
          <ScalarValue value={value} />
        </dd>
      </div>
    );
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <JsonProperty label={label} value={null} />;
    }
    if (value.length <= 4 && areScalars(value)) {
      return (
        <div className="grid min-h-9 grid-cols-[minmax(5.5rem,0.85fr)_minmax(0,1.15fr)] items-start gap-3 py-2 text-xs">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="flex min-w-0 flex-wrap gap-x-1.5">
            {withJsonKeys(value).map((entry, index) => (
              <span className="inline-flex gap-1.5" key={entry.key}>
                {index > 0 ? <span aria-hidden="true">·</span> : null}
                <ScalarValue value={entry.value} />
              </span>
            ))}
          </dd>
        </div>
      );
    }

    return (
      <CollectionDisclosure
        label={label}
        summary={`${value.length} ${value.length === 1 ? "item" : "items"}`}
      >
        <div className="divide-y divide-border/70">
          {withJsonKeys(value).map((entry, index) => (
            <JsonProperty
              key={entry.key}
              label={`Item ${index + 1}`}
              value={entry.value}
            />
          ))}
        </div>
      </CollectionDisclosure>
    );
  }

  const fieldCount = Object.keys(value).length;
  return (
    <CollectionDisclosure
      label={label}
      summary={`${fieldCount} ${fieldCount === 1 ? "field" : "fields"}`}
    >
      <JsonFields value={value} />
    </CollectionDisclosure>
  );
}

export function JsonPropertyInspector({ value }: { value: unknown }) {
  const json = readJsonValue(value);
  if (json === null && value !== null) {
    return <p className="text-muted-foreground text-xs">Result unavailable.</p>;
  }
  if (isScalar(json)) {
    return (
      <div className="text-sm">
        <ScalarValue value={json} />
      </div>
    );
  }
  if (Array.isArray(json)) {
    return <JsonProperty label="Items" value={json} />;
  }
  return <JsonFields value={json} />;
}

export function OutputDisplay({
  output,
  input,
  actionType,
}: {
  output: unknown;
  input?: unknown;
  actionType?: string;
}) {
  const catalog = useExtensionCatalog();
  const integrationUi = useIntegrationUi();

  // An integration's own renderer takes precedence over the plain base64 image
  // below, which is keyed on nothing but the shape of the output.
  const CustomComponent = actionType
    ? findOutputComponent(integrationUi, findAction(catalog, actionType))
    : undefined;
  const base64Image = CustomComponent ? null : readBase64ImageOutput(output);

  if (CustomComponent) {
    return (
      <div className="overflow-hidden rounded-lg border bg-muted/50 p-3">
        <CustomOutput
          component={CustomComponent}
          input={input}
          output={output}
        />
      </div>
    );
  }

  if (base64Image) {
    return (
      <div className="overflow-hidden rounded-lg border bg-muted/50 p-3">
        <img
          alt="Step output"
          className="max-h-96 w-auto rounded"
          height={384}
          src={`data:image/png;base64,${base64Image}`}
          width={384}
        />
      </div>
    );
  }

  return <JsonPropertyInspector value={output} />;
}

function CustomOutput({
  component: Component,
  input,
  output,
}: {
  component: ComponentType<ResultComponentProps>;
  input: unknown;
  output: unknown;
}) {
  return <Component input={input} output={output} />;
}
