import * as stylex from "@stylexjs/stylex";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { colorVars, spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import { useState } from "react";
import { type ExecutionLog } from "#src/lib/execution-logs";
import {
  CollapsibleSection,
  formatDuration,
  getStatusDotVariant,
  getStatusLabel,
  JsonWithLinks,
  OutputDisplay,
} from "./workflow-run-shared";

function TimelineEntry({
  log,
  isLast,
}: {
  log: ExecutionLog;
  isLast: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div {...stylex.props(styles.entry)}>
      {isLast ? null : <span aria-hidden {...stylex.props(styles.connector)} />}
      <span {...stylex.props(styles.dot)}>
        <StatusDot
          label={getStatusLabel(log.status)}
          variant={getStatusDotVariant(log.status)}
        />
      </span>
      <VStack gap={3} xstyle={styles.content}>
        <Button
          label={log.nodeName || log.nodeType}
          onClick={() => setIsExpanded(!isExpanded)}
          size="sm"
          variant="ghost"
          xstyle={styles.trigger}
        />
        <HStack align="center" gap={2}>
          <Text color="secondary" size="sm">
            {getStatusLabel(log.status)}
          </Text>
          {log.duration ? (
            <Text color="secondary" size="sm" xstyle={styles.monospace}>
              {formatDuration(log.duration)}
            </Text>
          ) : null}
        </HStack>

        {isExpanded ? (
          <VStack gap={3}>
            {log.input !== null && log.input !== undefined ? (
              <CollapsibleSection copyData={log.input} title="Input">
                <pre {...stylex.props(styles.codeBlock)}>
                  <JsonWithLinks data={log.input} />
                </pre>
              </CollapsibleSection>
            ) : null}
            {log.output !== null && log.output !== undefined ? (
              <OutputDisplay
                actionType={log.nodeType}
                input={log.input}
                output={log.output}
              />
            ) : null}
            {log.error ? (
              <CollapsibleSection
                copyData={log.error}
                defaultExpanded
                isError
                title="Error"
              >
                <pre {...stylex.props(styles.errorBlock)}>{log.error}</pre>
              </CollapsibleSection>
            ) : null}
            {log.input || log.output || log.error ? null : (
              <Card padding={3}>
                <Text color="secondary" size="sm">
                  No data recorded
                </Text>
              </Card>
            )}
          </VStack>
        ) : null}
      </VStack>
    </div>
  );
}

export function WorkflowRunTimeline({ logs }: { logs: ExecutionLog[] }) {
  if (logs.length === 0) {
    return (
      <Card padding={4}>
        <Text color="secondary" size="sm">
          No steps recorded
        </Text>
      </Card>
    );
  }

  return (
    <VStack gap={0}>
      {logs.map((log, index) => (
        <TimelineEntry
          isLast={index === logs.length - 1}
          key={log.id}
          log={log}
        />
      ))}
    </VStack>
  );
}

const styles = stylex.create({
  entry: {
    display: "grid",
    gap: spacingVars["--spacing-3"],
    gridTemplateColumns: "1rem minmax(0, 1fr)",
    paddingBlockEnd: spacingVars["--spacing-4"],
    position: "relative",
  },
  connector: {
    backgroundColor: colorVars["--color-border"],
    bottom: 0,
    left: 7,
    position: "absolute",
    top: 16,
    width: 1,
  },
  dot: {
    paddingBlockStart: spacingVars["--spacing-2"],
    position: "relative",
    zIndex: 1,
  },
  content: { minWidth: 0 },
  trigger: { justifyContent: "flex-start", maxWidth: "100%" },
  monospace: { fontFamily: "monospace", fontVariantNumeric: "tabular-nums" },
  codeBlock: {
    backgroundColor: colorVars["--color-neutral"],
    border: `1px solid ${colorVars["--color-border"]}`,
    borderRadius: 8,
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 1.6,
    margin: 0,
    overflow: "auto",
    padding: spacingVars["--spacing-3"],
  },
  errorBlock: {
    backgroundColor: colorVars["--color-neutral"],
    border: `1px solid ${colorVars["--color-error"]}`,
    borderRadius: 8,
    color: colorVars["--color-text-red"],
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 1.6,
    margin: 0,
    overflow: "auto",
    padding: spacingVars["--spacing-3"],
  },
});
