import { AlertTriangle } from "lucide-react";
import { Button } from "#src/components/ui/button";
import { IntegrationIcon } from "#src/components/ui/integration-icon";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useConnectionRepair } from "#src/hooks/use-connection-repair";
import { useIsMobile } from "#src/hooks/use-mobile";
import { ConfigureConnectionOverlay } from "./add-connection-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";
import type { OverlayComponentProps } from "./types";
import type { WorkflowIssuesOverlayModel } from "@wfgraph/shared/graph/workflow-issues";

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

  const handleGoToStep = (nodeId: string, fieldKey?: string) => {
    // Select the node and set tab (this is handled by onGoToStep)
    onGoToStep(nodeId, fieldKey);

    // On mobile, push ConfigurationOverlay on top so back button returns here
    // On desktop, close all overlays since the sidebar shows the config
    if (isMobile) {
      pushSheet();
    } else {
      closeAll();
    }
  };

  const handleAddIntegration = (integrationType: string) => {
    push(ConfigureConnectionOverlay, {
      type: integrationType,
      // The repair is what clears the issue. One integration type is listed
      // once here however many nodes need it, so the fix is the graph rather
      // than any one node, and the write's own list refresh leaves each node's
      // stored id as it was.
      onSuccess: () => void repairAgainstConnectionList(),
    });
  };

  const handleRunAnyway = () => {
    if (!onRunAnyway) {
      return;
    }
    closeAll();
    onRunAnyway();
  };

  const blockingIssueCount =
    missingRequiredFields.length + missingIntegrations.length;

  return (
    <Overlay
      actions={
        allowRunAnyway && onRunAnyway
          ? [
              {
                label: "Run Anyway",
                variant: "outline",
                onClick: handleRunAnyway,
              },
              { label: "Cancel", onClick: closeAll },
            ]
          : [{ label: "Close", onClick: closeAll }]
      }
      overlayId={overlayId}
      title={`Workflow Issues (${totalIssues})`}
    >
      <div className="flex items-center gap-2 text-warning">
        <AlertTriangle className="size-5" />
        <p className="text-muted-foreground text-sm">
          This workflow has issues that may cause it to fail.
        </p>
      </div>
      {blockingIssueCount > 0 && (
        <p className="mt-2 text-destructive text-sm">
          Resolve blocking issues before running this workflow.
        </p>
      )}

      <div className="mt-4 space-y-4">
        {/* Missing Connections Section */}
        {missingIntegrations.length > 0 && (
          <div className="space-y-1">
            <h4 className="font-medium text-muted-foreground text-sm">
              Missing Connections
            </h4>
            {missingIntegrations.map((missing) => (
              <div
                className="flex items-center gap-3 py-1"
                key={missing.integrationType}
              >
                <IntegrationIcon
                  className="size-4 shrink-0"
                  integration={missing.integrationType}
                />
                <p className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">
                    {missing.integrationLabel}
                  </span>
                  <span className="text-muted-foreground">
                    {" — "}
                    {missing.nodeNames.length > 3
                      ? `${missing.nodeNames.slice(0, 3).join(", ")} +${missing.nodeNames.length - 3} more`
                      : missing.nodeNames.join(", ")}
                  </span>
                </p>
                <Button
                  className="shrink-0"
                  onClick={() => handleAddIntegration(missing.integrationType)}
                  size="sm"
                  variant="outline"
                >
                  Add
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Broken References Section */}
        {brokenReferences.length > 0 && (
          <div className="space-y-2">
            <h4 className="font-medium text-muted-foreground text-sm">
              Broken References
            </h4>
            {brokenReferences.map((broken) => (
              <div key={broken.nodeId}>
                <p className="font-medium text-sm">{broken.nodeLabel}</p>
                <div className="mt-1 space-y-0.5">
                  {broken.brokenReferences.map((ref) => (
                    <div
                      className="flex items-center gap-3 py-0.5 pl-3"
                      key={`${broken.nodeId}-${ref.fieldKey}-${ref.displayText}-${ref.fieldLabel}`}
                    >
                      <p className="min-w-0 flex-1 text-muted-foreground text-sm">
                        <span className="font-mono">{ref.displayText}</span>
                        {" in "}
                        {ref.fieldLabel}
                      </p>
                      <Button
                        className="shrink-0"
                        onClick={() =>
                          handleGoToStep(broken.nodeId, ref.fieldKey)
                        }
                        size="sm"
                        variant="outline"
                      >
                        Fix
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Missing Required Fields Section */}
        {missingRequiredFields.length > 0 && (
          <div className="space-y-2">
            <h4 className="font-medium text-muted-foreground text-sm">
              Missing Required Fields
            </h4>
            {missingRequiredFields.map((node) => (
              <div key={node.nodeId}>
                <p className="font-medium text-sm">{node.nodeLabel}</p>
                <div className="mt-1 space-y-0.5">
                  {node.missingFields.map((field) => (
                    <div
                      className="flex items-center gap-3 py-0.5 pl-3"
                      key={`${node.nodeId}-${field.fieldKey}`}
                    >
                      <p className="min-w-0 flex-1 text-muted-foreground text-sm">
                        {field.fieldLabel}
                      </p>
                      <Button
                        className="shrink-0"
                        onClick={() =>
                          handleGoToStep(node.nodeId, field.fieldKey)
                        }
                        size="sm"
                        variant="outline"
                      >
                        Fix
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Overlay>
  );
}
