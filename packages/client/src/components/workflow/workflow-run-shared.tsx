import * as stylex from "@stylexjs/stylex";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { VStack } from "@astryxdesign/core/VStack";
import {
  colorVars,
  radiusVars,
  spacingVars,
} from "@astryxdesign/core/theme/tokens.stylex";
import { Check, Copy } from "lucide-react";
import { Schema } from "effect";
import { type ComponentType, useState } from "react";
import type { IntegrationUi, ResultComponentProps } from "@wfgraph/plugins/ui";
import { useIntegrationUi } from "#src/components/integration-ui-provider";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { getClientLogger } from "#src/lib/logger";
import {
  type ActionMetadata,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import type { WorkflowExecutionStatus } from "@wfgraph/shared/lifecycle/execution-contracts";
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

export function getStatusDotVariant(
  status: string
): "success" | "error" | "accent" | "warning" | "neutral" {
  const tone = toneOf(status);
  if (tone === "good") return "success";
  if (tone === "bad") return "error";
  if (tone === "info") return "accent";
  if (tone === "pending") return "warning";
  return "neutral";
}

export function getStatusLabel(status: string): string {
  return (
    (RUN_STATUS_LABELS as Record<string, string | undefined>)[status] ??
    (NODE_STATUS_LABELS as Record<string, string | undefined>)[status] ??
    "Unknown"
  );
}

export function getStatusTokenColor(
  status: string
): "green" | "red" | "blue" | "yellow" | "gray" {
  const tone = toneOf(status);
  if (tone === "good") return "green";
  if (tone === "bad") return "red";
  if (tone === "info") return "blue";
  if (tone === "pending") return "yellow";
  return "gray";
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
                href={innerValue}
                key={innerValue}
                rel="noopener noreferrer"
                target="_blank"
                {...stylex.props(styles.link)}
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
    <IconButton
      icon={<Icon icon={copied ? Check : Copy} size="sm" />}
      label={copied ? "Copied" : "Copy"}
      onClick={handleCopy}
      size="sm"
      variant="ghost"
    />
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
  return (
    <VStack gap={2}>
      <HStack align="center" gap={1} justify="between">
        <Collapsible
          defaultIsOpen={defaultExpanded}
          trigger={title}
          xstyle={styles.collapsible}
        >
          {children}
        </Collapsible>
        {copyData !== undefined ? (
          <CopyButton data={copyData} isError={isError} />
        ) : null}
      </HStack>
    </VStack>
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
  const catalog = useExtensionCatalog();
  const integrationUi = useIntegrationUi();

  // An integration's own renderer takes precedence over the plain base64 image
  // below, which is keyed on nothing but the shape of the output.
  const CustomComponent = actionType
    ? findOutputComponent(integrationUi, findAction(catalog, actionType))
    : undefined;
  const base64Image = CustomComponent ? null : readBase64ImageOutput(output);

  const renderRichResult = () => {
    if (CustomComponent) {
      return (
        <Card padding={3}>
          <CustomComponent input={input} output={output} />
        </Card>
      );
    }

    if (base64Image) {
      return (
        <Card padding={3}>
          <img
            alt="Step output"
            height={384}
            src={`data:image/png;base64,${base64Image}`}
            width={384}
            {...stylex.props(styles.image)}
          />
        </Card>
      );
    }

    return null;
  };

  const richResult = renderRichResult();

  return (
    <>
      <CollapsibleSection copyData={output} title="Output">
        <pre {...stylex.props(styles.codeBlock)}>
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

const styles = stylex.create({
  link: {
    color: colorVars["--color-text-accent"],
    textDecoration: "underline",
    textUnderlineOffset: 2,
  },
  collapsible: {
    flex: 1,
    minWidth: 0,
  },
  image: {
    borderRadius: radiusVars["--radius-element"],
    height: "auto",
    maxHeight: 384,
    maxWidth: "100%",
    width: "auto",
  },
  codeBlock: {
    backgroundColor: colorVars["--color-neutral"],
    borderColor: colorVars["--color-border"],
    borderRadius: radiusVars["--radius-container"],
    borderStyle: "solid",
    borderWidth: 1,
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 1.6,
    margin: 0,
    overflow: "auto",
    padding: spacingVars["--spacing-3"],
  },
});
