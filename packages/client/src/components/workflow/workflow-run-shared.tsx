import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { Schema } from "effect";
import { type ComponentType, useState } from "react";
import type { IntegrationUi, ResultComponentProps } from "@rova/plugins/ui";
import { Button } from "#src/components/ui/button";
import { useIntegrationUi } from "#src/components/integration-ui-provider";
import { getExtensionCatalog } from "#src/lib/extensions";
import {
  type ActionMetadata,
  findAction,
} from "@rova/shared/extensions/catalog";
import type { WorkflowExecutionStatus } from "@rova/shared/lifecycle/execution-contracts";
import { readAs } from "@rova/shared/types/schema";

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
  return (
    (RUN_STATUS_LABELS as Record<string, string | undefined>)[status] ??
    (NODE_STATUS_LABELS as Record<string, string | undefined>)[status] ??
    "Unknown"
  );
}

export function getStatusBadgeClass(status: string): string {
  return BADGE_CLASSES[toneOf(status)];
}

export function formatDuration(duration: string): string {
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
          {copyData !== undefined ? (
            <CopyButton data={copyData} isError={isError} />
          ) : null}
        </div>
      </div>
      {isOpen ? children : null}
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

export function OutputDisplay({
  output,
  input,
  actionType,
}: {
  output: unknown;
  input?: unknown;
  actionType?: string;
}) {
  const integrationUi = useIntegrationUi();

  // An integration's own renderer takes precedence over the plain base64 image
  // below, which is keyed on nothing but the shape of the output.
  const CustomComponent = actionType
    ? findOutputComponent(
        integrationUi,
        findAction(getExtensionCatalog(), actionType)
      )
    : undefined;
  const base64Image = CustomComponent ? null : readBase64ImageOutput(output);

  const renderRichResult = () => {
    if (CustomComponent) {
      return (
        <div className="overflow-hidden rounded-lg border bg-muted/50 p-3">
          <CustomComponent input={input} output={output} />
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

    return null;
  };

  const richResult = renderRichResult();

  return (
    <>
      <CollapsibleSection copyData={output} title="Output">
        <pre className="overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
          <JsonWithLinks data={output} />
        </pre>
      </CollapsibleSection>

      {richResult ? (
        <CollapsibleSection defaultExpanded title="Result">
          {richResult}
        </CollapsibleSection>
      ) : null}
    </>
  );
}
