import { AlertTriangle } from "lucide-react";
import { Button } from "#src/components/ui/button";
import { IntegrationIcon } from "#src/components/ui/integration-icon";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useConnectionRepair } from "#src/hooks/use-connection-repair";
import { workflowIssuesLabel } from "#src/components/workflow/workflow-issues-chip";
import { useIsMobile } from "#src/hooks/use-mobile";
import { ConfigureConnectionOverlay } from "./add-connection-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";
import type { OverlayComponentProps } from "./types";
import type { WorkflowIssuesOverlayModel } from "@wfgraph/shared/graph/workflow-issues";

type WorkflowIssuesOverlayProps = OverlayComponentProps<{
  issues: WorkflowIssuesOverlayModel;
  onGoToStep: (nodeId: string, fieldKey?: string) => void;
  /**
   * Starts the draft run these issues were collected for. Absent whenever a
   * blocking issue stands, and absent for every reader who opened the list on
   * their own. A run of the published version never arrives here: publish
   * refused that graph's blocking issues before it became a version.
   */
  onRunDraftAnyway?: () => void;
  allowRunDraftAnyway?: boolean;
}>;

/** Count the individual repairs represented by the overlay's grouped rows. */
export function workflowIssueCount(issues: WorkflowIssuesOverlayModel): number {
  return issues.totalIssues;
}

/**
 * Which repair row wears the dialog's ink, named by its section and the row it
 * sits in. Null when the list holds no repair at all.
 */
type PrimaryRepair = {
  section: "integration" | "reference" | "unverified" | "required";
  rowKey: string;
};

/**
 * The first repair button the body renders, wherever it turns up.
 *
 * The reader came here to fix something, so one button is filled and it is the
 * first one they can press. Choosing it from a single section left a dialog
 * whose issues were all node-level with every button in the same outline
 * weight. Sections are searched in the order they render, and one whose rows
 * are all empty is passed over.
 */
function primaryRepair(
  issues: WorkflowIssuesOverlayModel
): PrimaryRepair | null {
  const integration = issues.missingIntegrations[0];
  if (integration) {
    return { section: "integration", rowKey: integration.integrationType };
  }

  const reference = issues.brokenReferences.find(
    (node) => node.brokenReferences.length > 0
  );
  if (reference) {
    return { section: "reference", rowKey: reference.nodeId };
  }

  const unverified = issues.unverifiedProviderFields.find(
    (node) => node.fields.length > 0
  );
  if (unverified) {
    return { section: "unverified", rowKey: unverified.nodeId };
  }

  const required = issues.missingRequiredFields.find(
    (node) => node.missingFields.length > 0
  );
  return required ? { section: "required", rowKey: required.nodeId } : null;
}

export function WorkflowIssuesOverlay({
  overlayId,
  issues,
  onGoToStep,
  onRunDraftAnyway,
  allowRunDraftAnyway = false,
}: WorkflowIssuesOverlayProps) {
  const { push, closeAll } = useOverlay();
  const { pushSheet } = useConfigurationSheet();
  const isMobile = useIsMobile();
  const repairAgainstConnectionList = useConnectionRepair();

  const {
    brokenReferences,
    missingRequiredFields,
    missingIntegrations,
    unverifiedProviderFields,
  } = issues;

  const totalIssues = workflowIssueCount(issues);

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

  const handleRunDraftAnyway = () => {
    if (!onRunDraftAnyway) {
      return;
    }
    closeAll();
    onRunDraftAnyway();
  };

  const blockingIssueCount =
    missingRequiredFields.length + missingIntegrations.length;

  const primary = primaryRepair(issues);

  /** Whether this row is the one repair the dialog fills. */
  const isPrimaryRepair = (
    section: PrimaryRepair["section"],
    rowKey: string,
    index: number
  ) => index === 0 && primary?.section === section && primary.rowKey === rowKey;

  return (
    <Overlay
      actions={
        allowRunDraftAnyway && onRunDraftAnyway
          ? [
              {
                label: "Run draft anyway",
                variant: "outline",
                onClick: handleRunDraftAnyway,
              },
              { label: "Cancel", variant: "outline", onClick: closeAll },
            ]
          : [
              {
                label: "Close",
                // Ink only when the list offers nothing to repair. Otherwise
                // the filled button belongs to the first repair, and Close is
                // the way out rather than the thing to do.
                variant: primary ? "outline" : "default",
                onClick: closeAll,
              },
            ]
      }
      overlayId={overlayId}
      // The same count the status strip's chip carries, said the same way, so
      // the list opens under the words that opened it.
      title={workflowIssuesLabel(totalIssues)}
    >
      {/* One sentence, and the blocker's is the one that survives: a reader
          with a blocking issue needs the harder fact, and printing both left
          the softer one to be read first. */}
      {blockingIssueCount > 0 ? (
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="size-5" />
          <p className="text-sm">
            Resolve blocking issues before running the draft.
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-warning">
          <AlertTriangle className="size-5" />
          <p className="text-sm">
            The draft has issues that may cause it to fail.
          </p>
        </div>
      )}

      <div className="mt-4 space-y-4">
        {/* Missing Connections Section */}
        {missingIntegrations.length > 0 && (
          <div className="space-y-1">
            <h4 className="font-medium text-muted-foreground text-sm">
              Missing Connections
            </h4>
            {missingIntegrations.map((missing, index) => (
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
                  variant={
                    isPrimaryRepair(
                      "integration",
                      missing.integrationType,
                      index
                    )
                      ? "default"
                      : "outline"
                  }
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
                  {broken.brokenReferences.map((ref, index) => (
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
                        variant={
                          isPrimaryRepair("reference", broken.nodeId, index)
                            ? "default"
                            : "outline"
                        }
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

        {/* Unverified Provider Fields Section */}
        {unverifiedProviderFields.length > 0 && (
          <div className="space-y-2">
            <h4 className="font-medium text-muted-foreground text-sm">
              Unchecked Fields
            </h4>
            <p className="text-muted-foreground text-xs">
              The connection did not answer, so these fields went unchecked.
              Reconnect it to see what they still need.
            </p>
            {unverifiedProviderFields.map((node) => (
              <div key={node.nodeId}>
                <p className="font-medium text-sm">{node.nodeLabel}</p>
                <div className="mt-1 space-y-0.5">
                  {node.fields.map((field, index) => (
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
                        variant={
                          isPrimaryRepair("unverified", node.nodeId, index)
                            ? "default"
                            : "outline"
                        }
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
                  {node.missingFields.map((field, index) => (
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
                        variant={
                          isPrimaryRepair("required", node.nodeId, index)
                            ? "default"
                            : "outline"
                        }
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
