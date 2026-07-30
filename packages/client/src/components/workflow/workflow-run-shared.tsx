import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
} from "lucide-react";
import { Schema } from "effect";
import { useState } from "react";
import { Button } from "#src/components/ui/button";
import {
  OUTPUT_DISPLAY_CONFIGS,
  type OutputDisplayConfig,
} from "#src/lib/output-display-configs";
import type { WorkflowExecutionStatus } from "@rova/shared/workflow/execution-contracts";
import { readAs } from "@rova/shared/types/schema";
import { getActionOutputComponent } from "@rova/shared/plugins/ui-registry";

/**
 * How a status reads on screen, for the two vocabularies that reach these.
 *
 * An Execution ends `completed`, `failed`, `canceled` or `superseded`; a node
 * inside one ends `success`, `error` or `cancelled`. Both arrive here as strings
 * off a payload, so the lookups are records rather than switches and `satisfies`
 * is what holds each to naming every member of its own union.
 */
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
  good: "bg-green-600",
  bad: "bg-red-600",
  info: "bg-blue-600",
  pending: "bg-amber-600",
  quiet: "bg-slate-600",
  muted: "bg-muted-foreground",
};

const LABELS: Record<StatusTone, string> = {
  good: "Success",
  bad: "Error",
  info: "Running",
  pending: "Waiting",
  quiet: "Cancelled",
  muted: "Unknown",
};

const BADGE_CLASSES: Record<StatusTone, string> = {
  good: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
  bad: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  info: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  pending:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  quiet:
    "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  muted: "border-muted bg-muted/40 text-muted-foreground",
};

export function getStatusDotClass(status: string): string {
  return DOT_CLASSES[toneOf(status)];
}

export function getStatusLabel(status: string): string {
  // Superseded is the one run status whose label is not its tone's: a displaced
  // run was not cancelled, and a builder reading "Cancelled" would go looking for
  // who cancelled it.
  return status === "superseded" ? "Superseded" : LABELS[toneOf(status)];
}

export function getStatusBadgeClass(status: string): string {
  return BADGE_CLASSES[toneOf(status)];
}

export function formatDuration(duration: string): string {
  const ms = Number.parseInt(duration, 10);
  return ms < 1000 ? `${duration}ms` : `${(ms / 1000).toFixed(2)}s`;
}

// Data helpers

function getOutputConfig(nodeType: string): OutputDisplayConfig | undefined {
  return OUTPUT_DISPLAY_CONFIGS[nodeType];
}

const readNonEmptyString = readAs(Schema.NonEmptyString);

/**
 * Read the one field a display config names out of a step's stored output.
 *
 * The output is JSONB coming back from the database, so the field is read rather
 * than assumed. The key comes from the plugin's own display config, so the object
 * is stepped into by hand and the leaf is what gets validated.
 */
function getOutputDisplayValue(
  output: unknown,
  config: { type: "image" | "video" | "url"; field: string }
): string | undefined {
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return undefined;
  }

  return readNonEmptyString(Reflect.get(output, config.field));
}

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
                className="text-blue-500 underline hover:text-blue-400"
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
      console.error("Failed to copy:", error);
    }
  };

  return (
    <Button
      className="h-7 px-2"
      onClick={handleCopy}
      size="sm"
      type="button"
      variant="ghost"
    >
      {copied ? (
        <Check className="h-3 w-3 text-green-600" />
      ) : (
        <Copy className="h-3 w-3" />
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
  externalLink,
}: {
  title: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  copyData?: unknown;
  isError?: boolean;
  externalLink?: string;
}) {
  const [isOpen, setIsOpen] = useState(defaultExpanded);

  return (
    <div>
      <div className="mb-2 flex w-full items-center justify-between">
        <button
          className="flex items-center gap-1.5"
          onClick={() => setIsOpen(!isOpen)}
          type="button"
        >
          {isOpen ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
          <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {title}
          </span>
        </button>
        <div className="flex items-center gap-1">
          {externalLink ? (
            <Button
              className="h-7 px-2"
              render={
                <a
                  href={externalLink}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <span className="sr-only">Open external link</span>
                </a>
              }
              size="sm"
              variant="ghost"
            >
              <ExternalLink className="h-3 w-3" />
            </Button>
          ) : null}
          {copyData !== undefined ? (
            <CopyButton data={copyData} isError={isError} />
          ) : null}
        </div>
      </div>
      {isOpen ? children : null}
    </div>
  );
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
  // A plugin can render its own output with a React component, which it
  // registers from its ui.ts. When one exists it takes precedence, and the
  // simple field-based display falls back to this app's own config table.
  const CustomComponent = actionType
    ? getActionOutputComponent(actionType)
    : undefined;
  const builtInConfig = actionType ? getOutputConfig(actionType) : undefined;
  const effectiveBuiltInConfig = CustomComponent ? undefined : builtInConfig;
  const displayValue = effectiveBuiltInConfig
    ? getOutputDisplayValue(output, effectiveBuiltInConfig)
    : undefined;
  const legacyBase64Output = readBase64ImageOutput(output);
  const isLegacyBase64 =
    !(CustomComponent || builtInConfig) && !!legacyBase64Output;

  const renderRichResult = () => {
    if (CustomComponent) {
      return (
        <div className="overflow-hidden rounded-lg border bg-muted/50 p-3">
          <CustomComponent input={input} output={output} />
        </div>
      );
    }

    if (effectiveBuiltInConfig && displayValue) {
      switch (effectiveBuiltInConfig.type) {
        case "image": {
          const imageSrc =
            effectiveBuiltInConfig.field === "base64" &&
            !displayValue.startsWith("data:")
              ? `data:image/png;base64,${displayValue}`
              : displayValue;
          return (
            <div className="overflow-hidden rounded-lg border bg-muted/50 p-3">
              <img
                alt="Generated output"
                className="max-h-96 w-auto rounded"
                height={384}
                src={imageSrc}
                width={384}
              />
            </div>
          );
        }
        case "video":
          return (
            <div className="overflow-hidden rounded-lg border bg-muted/50 p-3">
              <video
                className="max-h-96 w-auto rounded"
                controls
                src={displayValue}
              >
                <track kind="captions" />
              </video>
            </div>
          );
        case "url":
          return (
            <div className="overflow-hidden rounded-lg border bg-muted/50">
              <iframe
                className="h-96 w-full rounded"
                sandbox="allow-scripts"
                src={displayValue}
                title="Output preview"
              />
            </div>
          );
        default:
          return null;
      }
    }

    if (isLegacyBase64) {
      return (
        <div className="overflow-hidden rounded-lg border bg-muted/50 p-3">
          <img
            alt="AI output"
            className="max-h-96 w-auto rounded"
            height={384}
            src={`data:image/png;base64,${legacyBase64Output}`}
            width={384}
          />
        </div>
      );
    }

    return null;
  };

  const richResult = renderRichResult();
  const hasRichResult = richResult !== null;
  const externalLink =
    effectiveBuiltInConfig?.type === "url" && displayValue
      ? displayValue
      : undefined;

  return (
    <>
      <CollapsibleSection copyData={output} title="Output">
        <pre className="overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
          <JsonWithLinks data={output} />
        </pre>
      </CollapsibleSection>

      {hasRichResult ? (
        <CollapsibleSection
          defaultExpanded
          externalLink={externalLink}
          title="Result"
        >
          {richResult}
        </CollapsibleSection>
      ) : null}
    </>
  );
}
