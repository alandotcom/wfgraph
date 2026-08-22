import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { getRelativeTime } from "@wfgraph/shared/utils/time";
import {
  type ExecutionEvent,
  type ExecutionLog,
  type ExecutionWait,
  isRunInProgress,
  type WorkflowExecution,
} from "#src/lib/execution-logs";
import { CollapsibleSection } from "./workflow-run-shared";
import { WorkflowRunSummaryRow } from "./workflow-run-summary-row";
import { WorkflowRunTimeline } from "./workflow-run-timeline";

type WorkflowRunDetailProps = {
  execution: WorkflowExecution;
  runNumber: number;
  notice?: string;
  logs: ExecutionLog[];
  events: ExecutionEvent[];
  waits: ExecutionWait[];
  isCanceling: boolean;
  isResuming: boolean;
  onBack: () => void;
  onCancel: (executionId: string) => void;
  onResume: (token: string) => void;
};

export function WorkflowRunDetail({
  execution,
  runNumber,
  notice,
  logs,
  events,
  waits,
  isCanceling,
  isResuming,
  onBack,
  onCancel,
  onResume,
}: WorkflowRunDetailProps) {
  const sortedLogs = logs.toSorted(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );

  return (
    <VStack gap={4}>
      <WorkflowRunSummaryRow
        execution={execution}
        leading={{ onBack, type: "back" }}
        runNumber={runNumber}
        showStartEventName
        trailing={
          isRunInProgress(execution.status)
            ? { isCanceling, onCancel, type: "cancel" }
            : { type: "spacer" }
        }
      />

      {notice ? (
        <Banner
          description={notice}
          status="info"
          title="Run no longer listed"
        />
      ) : null}

      {waits.map((wait) => (
        <Card key={wait.id} padding={3}>
          <VStack gap={2}>
            <Text size="sm" weight="medium">
              Parked at {wait.nodeName}
            </Text>
            <Text color="secondary" size="sm">
              {wait.subscribedEvents.length > 0
                ? `Waiting for ${wait.subscribedEvents.join(", ")}`
                : "Waiting on a timer"}
            </Text>
            {wait.resumeToken ? (
              <Button
                isDisabled={isResuming}
                isLoading={isResuming}
                label="Resume now"
                onClick={() => onResume(wait.resumeToken ?? "")}
                size="sm"
                variant="secondary"
              />
            ) : null}
          </VStack>
        </Card>
      ))}

      <WorkflowRunTimeline logs={sortedLogs} />

      {events.length > 0 ? (
        <CollapsibleSection title="Audit events">
          <VStack gap={2}>
            {events.map((event) => (
              <Card key={event.id} padding={2}>
                <HStack align="center" gap={3} justify="between">
                  <VStack gap={1}>
                    <Text size="sm" weight="medium">
                      {event.message}
                    </Text>
                    <Text color="secondary" size="sm">
                      {event.eventType}
                    </Text>
                  </VStack>
                  <Text color="secondary" size="sm">
                    {getRelativeTime(event.createdAt)}
                  </Text>
                </HStack>
              </Card>
            ))}
          </VStack>
        </CollapsibleSection>
      ) : null}
    </VStack>
  );
}
