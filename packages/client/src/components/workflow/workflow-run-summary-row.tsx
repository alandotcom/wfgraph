import * as stylex from "@stylexjs/stylex";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { colorVars, spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import { ArrowLeft, Ban } from "lucide-react";
import type { ReactNode } from "react";
import { getRelativeTime } from "@wfgraph/shared/utils/time";
import { type WorkflowExecution } from "#src/lib/execution-logs";
import {
  formatDuration,
  getStatusDotVariant,
  getStatusLabel,
  getStatusTokenColor,
} from "./workflow-run-shared";

type LeadingSlot = { type: "spacer" } | { type: "back"; onBack: () => void };

type TrailingSlot =
  | { type: "spacer" }
  | {
      type: "cancel";
      isCanceling: boolean;
      onCancel: (executionId: string) => void;
    };

type WorkflowRunSummaryRowProps = {
  execution: WorkflowExecution;
  runNumber: number;
  leading: LeadingSlot;
  trailing: TrailingSlot;
  onClick?: () => void;
  selected?: boolean;
  showStartEventName?: boolean;
};

function renderLeadingSlot(leading: LeadingSlot): ReactNode {
  if (leading.type === "back") {
    return (
      <IconButton
        icon={<Icon icon={ArrowLeft} size="sm" />}
        label="Back to runs list"
        onClick={leading.onBack}
        size="sm"
        variant="ghost"
      />
    );
  }

  return <span aria-hidden {...stylex.props(styles.slot)} />;
}

function renderTrailingSlot(
  execution: WorkflowExecution,
  trailing: TrailingSlot
): ReactNode {
  if (trailing.type === "cancel") {
    return (
      <Button
        icon={<Icon icon={Ban} size="sm" />}
        isDisabled={trailing.isCanceling}
        isLoading={trailing.isCanceling}
        label="Cancel"
        onClick={() => trailing.onCancel(execution.id)}
        size="sm"
        variant="secondary"
      />
    );
  }

  return <span aria-hidden {...stylex.props(styles.trailingSlot)} />;
}

function SummaryContent({
  execution,
  runNumber,
  showStartEventName,
}: Pick<
  WorkflowRunSummaryRowProps,
  "execution" | "runNumber" | "showStartEventName"
>) {
  return (
    <HStack align="start" gap={3} xstyle={styles.summary}>
      <StatusDot
        label={getStatusLabel(execution.status)}
        variant={getStatusDotVariant(execution.status)}
      />
      <VStack gap={1} xstyle={styles.summaryText}>
        <HStack align="center" gap={2} wrap="wrap">
          <Text size="sm" weight="medium">
            Run #{runNumber}
          </Text>
          <Token
            color={getStatusTokenColor(execution.status)}
            label={getStatusLabel(execution.status)}
            size="sm"
          />
          {execution.runMode === "test" ? (
            <Token color="yellow" label="Test Mode" size="sm" />
          ) : null}
        </HStack>
        <HStack align="center" gap={2} wrap="wrap">
          <Text color="secondary" size="sm">
            {getRelativeTime(execution.startedAt)}
          </Text>
          {execution.startSource ? (
            <Text color="secondary" size="sm">
              {execution.startSource}
            </Text>
          ) : null}
          {showStartEventName && execution.startEventName ? (
            <Text color="secondary" size="sm">
              {execution.startEventName}
            </Text>
          ) : null}
          {execution.duration ? (
            <Text color="secondary" size="sm" xstyle={styles.monospace}>
              {formatDuration(execution.duration)}
            </Text>
          ) : null}
        </HStack>
      </VStack>
    </HStack>
  );
}

export function WorkflowRunSummaryRow({
  execution,
  runNumber,
  leading,
  trailing,
  onClick,
  selected = false,
  showStartEventName = false,
}: WorkflowRunSummaryRowProps) {
  const content = (
    <>
      {renderLeadingSlot(leading)}
      <SummaryContent
        execution={execution}
        runNumber={runNumber}
        showStartEventName={showStartEventName}
      />
      {renderTrailingSlot(execution, trailing)}
    </>
  );

  if (onClick) {
    return (
      <button
        {...stylex.props(styles.row, selected && styles.selectedRow)}
        data-testid="workflow-run-summary-row"
        data-selected={selected || undefined}
        onClick={onClick}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <div
      {...stylex.props(styles.row, styles.staticRow)}
      data-testid="workflow-run-summary-row"
      data-selected={selected || undefined}
    >
      {content}
    </div>
  );
}

const styles = stylex.create({
  row: {
    alignItems: "start",
    backgroundColor: {
      default: "transparent",
      ":hover": colorVars["--color-background-muted"],
    },
    border: 0,
    color: "inherit",
    cursor: "pointer",
    display: "grid",
    gap: spacingVars["--spacing-3"],
    gridTemplateColumns: "2rem minmax(0, 1fr) auto",
    paddingBlock: spacingVars["--spacing-3"],
    paddingInline: spacingVars["--spacing-1"],
    textAlign: "left",
    width: "100%",
  },
  staticRow: { cursor: "default" },
  selectedRow: { backgroundColor: colorVars["--color-background-muted"] },
  slot: { display: "block", height: 32, width: 32 },
  trailingSlot: { display: "block", width: 72 },
  summary: { minWidth: 0, paddingBlockStart: spacingVars["--spacing-1"] },
  summaryText: { minWidth: 0 },
  monospace: { fontFamily: "monospace", fontVariantNumeric: "tabular-nums" },
});
