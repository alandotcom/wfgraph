import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { ReactNode } from "react";
import { IntegrationIcon } from "#src/components/integration-icon";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useConnectionRepair } from "#src/hooks/use-connection-repair";
import { useIsMobile } from "#src/hooks/use-mobile";
import type { WorkflowIssuesOverlayModel } from "@wfgraph/shared/graph/workflow-issues";
import { ConfigureConnectionOverlay } from "./add-connection-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";
import type { OverlayComponentProps } from "./types";

type WorkflowIssuesOverlayProps = OverlayComponentProps<{
  issues: WorkflowIssuesOverlayModel;
  onGoToStep: (nodeId: string, fieldKey?: string) => void;
  onRunAnyway?: () => void;
  allowRunAnyway?: boolean;
}>;

export function WorkflowIssuesOverlay({
  overlayId,
  issues,
  onGoToStep,
  onRunAnyway,
  allowRunAnyway = false,
}: WorkflowIssuesOverlayProps) {
  const { push, closeAll } = useOverlay();
  const { pushSheet } = useConfigurationSheet();
  const isMobile = useIsMobile();
  const repairAgainstConnectionList = useConnectionRepair();
  const { brokenReferences, missingRequiredFields, missingIntegrations } =
    issues;
  const totalIssues =
    brokenReferences.length +
    missingRequiredFields.length +
    missingIntegrations.length;
  const blockingIssueCount =
    missingRequiredFields.length + missingIntegrations.length;

  const handleGoToStep = (nodeId: string, fieldKey?: string) => {
    onGoToStep(nodeId, fieldKey);
    if (isMobile) {
      pushSheet();
    } else {
      closeAll();
    }
  };

  const handleAddIntegration = (integrationType: string) => {
    push(ConfigureConnectionOverlay, {
      type: integrationType,
      onSuccess: () => void repairAgainstConnectionList(),
    });
  };

  const handleRunAnyway = () => {
    if (onRunAnyway) {
      closeAll();
      onRunAnyway();
    }
  };

  return (
    <Overlay
      actions={
        allowRunAnyway && onRunAnyway
          ? [
              {
                label: "Run Anyway",
                variant: "secondary",
                onClick: handleRunAnyway,
              },
              { label: "Cancel", onClick: closeAll },
            ]
          : [{ label: "Close", onClick: closeAll }]
      }
      overlayId={overlayId}
      title={`Workflow Issues (${totalIssues})`}
    >
      <VStack gap={4}>
        <Banner
          description="This workflow has issues that may cause it to fail."
          status="warning"
          title={
            blockingIssueCount > 0
              ? "Resolve blocking issues before running"
              : "Review workflow issues"
          }
        />

        {missingIntegrations.length > 0 ? (
          <IssueSection title="Missing connections">
            <List density="balanced" hasDividers>
              {missingIntegrations.map((missing) => (
                <ListItem
                  description={
                    <Text color="secondary" type="supporting">
                      {missing.nodeNames.length > 3
                        ? `${missing.nodeNames.slice(0, 3).join(", ")} +${missing.nodeNames.length - 3} more`
                        : missing.nodeNames.join(", ")}
                    </Text>
                  }
                  endContent={
                    <Button
                      label="Add"
                      onClick={() =>
                        handleAddIntegration(missing.integrationType)
                      }
                      size="sm"
                      variant="secondary"
                    />
                  }
                  key={missing.integrationType}
                  label={missing.integrationLabel}
                  startContent={
                    <IntegrationIcon integration={missing.integrationType} />
                  }
                />
              ))}
            </List>
          </IssueSection>
        ) : null}

        {brokenReferences.length > 0 ? (
          <IssueSection title="Broken references">
            <VStack gap={3}>
              {brokenReferences.map((broken) => (
                <VStack gap={1} key={broken.nodeId}>
                  <Text type="label">{broken.nodeLabel}</Text>
                  {broken.brokenReferences.map((reference) => (
                    <HStack
                      align="center"
                      gap={3}
                      justify="between"
                      key={`${broken.nodeId}-${reference.fieldKey}-${reference.displayText}-${reference.fieldLabel}`}
                    >
                      <Text color="secondary">
                        {reference.displayText} in {reference.fieldLabel}
                      </Text>
                      <Button
                        label="Fix"
                        onClick={() =>
                          handleGoToStep(broken.nodeId, reference.fieldKey)
                        }
                        size="sm"
                        variant="secondary"
                      />
                    </HStack>
                  ))}
                </VStack>
              ))}
            </VStack>
          </IssueSection>
        ) : null}

        {missingRequiredFields.length > 0 ? (
          <IssueSection title="Missing required fields">
            <VStack gap={3}>
              {missingRequiredFields.map((node) => (
                <VStack gap={1} key={node.nodeId}>
                  <Text type="label">{node.nodeLabel}</Text>
                  {node.missingFields.map((field) => (
                    <HStack
                      align="center"
                      gap={3}
                      justify="between"
                      key={`${node.nodeId}-${field.fieldKey}`}
                    >
                      <Text color="secondary">{field.fieldLabel}</Text>
                      <Button
                        label="Fix"
                        onClick={() =>
                          handleGoToStep(node.nodeId, field.fieldKey)
                        }
                        size="sm"
                        variant="secondary"
                      />
                    </HStack>
                  ))}
                </VStack>
              ))}
            </VStack>
          </IssueSection>
        ) : null}
      </VStack>
    </Overlay>
  );
}

function IssueSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <VStack gap={2}>
      <Text color="secondary" type="label">
        {title}
      </Text>
      {children}
    </VStack>
  );
}
