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
import { findActionById } from "@rova/shared/plugins/registry";
import { readAs } from "@rova/shared/types/schema";
import { getActionOutputComponent } from "@rova/shared/plugins/ui-registry";

// Status helpers

export function getStatusDotClass(status: string): string {
  switch (status) {
    case "success":
      return "bg-green-600";
    case "error":
      return "bg-red-600";
    case "running":
      return "bg-blue-600";
    case "waiting":
      return "bg-amber-600";
    case "cancelled":
      return "bg-slate-600";
    default:
      return "bg-muted-foreground";
  }
}

export function getStatusLabel(status: string): string {
  switch (status) {
    case "success":
      return "Success";
    case "error":
      return "Error";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "cancelled":
      return "Cancelled";
    default:
      return "Unknown";
  }
}

export function getStatusBadgeClass(status: string): string {
  switch (status) {
    case "success":
      return "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300";
    case "error":
      return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
    case "running":
      return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";
    case "waiting":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "cancelled":
      return "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300";
    default:
      return "border-muted bg-muted/40 text-muted-foreground";
  }
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
  const action = actionType ? findActionById(actionType) : undefined;
  const pluginConfig = action?.outputConfig;
  // A plugin can render its own output with a React component, which it
  // registers from its ui.ts. When one exists it takes precedence, and the
  // simple field-based display falls back to this app's own config table.
  const CustomComponent = actionType
    ? getActionOutputComponent(actionType)
    : undefined;
  const builtInConfig = actionType ? getOutputConfig(actionType) : undefined;
  const effectiveBuiltInConfig = CustomComponent ? builtInConfig : pluginConfig;
  const displayValue = effectiveBuiltInConfig
    ? getOutputDisplayValue(output, effectiveBuiltInConfig)
    : undefined;
  const legacyBase64Output = readBase64ImageOutput(output);
  const isLegacyBase64 =
    !(CustomComponent || pluginConfig || builtInConfig) && !!legacyBase64Output;

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
