import { AlertTriangle } from "lucide-react";
import { cn } from "@wfgraph/shared/utils";
import { Button } from "#src/components/ui/button";
import { IntegrationIcon } from "#src/components/ui/integration-icon";
import { useConnectionRepair } from "#src/hooks/use-connection-repair";
import { workflowIssuesLabel } from "#src/components/workflow/workflow-issues-chip";
import { ConfigureConnectionOverlay } from "./add-connection-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";
import type { OverlayComponentProps } from "./types";
import type { WorkflowIssuesOverlayModel } from "@wfgraph/shared/graph/workflow-issues";

/**
 * What opened the list: a Run draft or Publish that the issues stopped, or a
 * person opening the list from the status strip. A list a Run draft opened
 * carries `onRunDraftAnyway`, which starts the draft run the issues were
 * collected for; it is absent whenever an issue that stops a draft run stands.
 * A run of the published version never arrives here, because publish refused
 * that graph's blocking issues before it became a version.
 */
type WorkflowIssuesTrigger =
  | { trigger: "run"; onRunDraftAnyway?: (() => void) | undefined }
  | { trigger: "publish" }
  | { trigger: "list" };

/** What a caller opening the issues list passes. */
export type WorkflowIssuesOverlayInput = {
  issues: WorkflowIssuesOverlayModel;
  onGoToStep: (nodeId: string, fieldKey?: string) => void;
} & WorkflowIssuesTrigger;

type WorkflowIssuesOverlayProps =
  OverlayComponentProps<WorkflowIssuesOverlayInput>;

/** Count the individual repairs represented by the overlay's grouped rows. */
export function workflowIssueCount(issues: WorkflowIssuesOverlayModel): number {
  return issues.totalIssues;
}

export function WorkflowIssuesOverlay(props: WorkflowIssuesOverlayProps) {
  const { overlayId, issues, trigger, onGoToStep } = props;
  const onRunDraftAnyway =
    props.trigger === "run" ? props.onRunDraftAnyway : undefined;
  const { push, closeAll } = useOverlay();
  const repairAgainstConnectionList = useConnectionRepair();

  const {
    brokenReferences,
    invalidGroups,
    invalidLifecycleRules,
    missingRequiredFields,
    missingIntegrations,
    unverifiedProviderFields,
  } = issues;

  const totalIssues = workflowIssueCount(issues);

  const handleGoToStep = (nodeId: string, fieldKey?: string) => {
    // `onGoToStep` opens the step in Canvas Reveal, or in the mobile Reveal
    // sequence on a phone, so the list closes to show it.
    onGoToStep(nodeId, fieldKey);
    closeAll();
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

  return (
    <Overlay
      actions={
        onRunDraftAnyway
          ? [
              {
                label: "Run draft anyway",
                variant: "outline",
                onClick: handleRunDraftAnyway,
              },
              { label: "Cancel", variant: "outline", onClick: closeAll },
            ]
          : [
              // The dialog fills no button. Every row here is a repair the
              // reader might take, and Close is the way out rather than the
              // thing to do, so none of them outranks the others.
              {
                label: "Close",
                variant: "outline" as const,
                onClick: closeAll,
              },
            ]
      }
      overlayId={overlayId}
      // The same count the status strip's chip carries, said the same way, so
      // the list opens under the words that opened it.
      title={workflowIssuesLabel(totalIssues)}
    >
      {/* One sentence, and the hardest fact is the one that survives: an
          issue stopping the action that opened the list outranks one that
          stops only Publish, such as a Group problem, and that outranks a
          warning. */}
      <IssuesHeadline issues={issues} trigger={trigger} />

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
                  aria-label={`Add Connection for ${missing.integrationLabel}`}
                  className="shrink-0"
                  onClick={() => handleAddIntegration(missing.integrationType)}
                  size="sm"
                  variant="outline"
                >
                  Add Connection
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Group Rules Section */}
        {invalidGroups.length > 0 && (
          <div className="space-y-2">
            <h4 className="font-medium text-muted-foreground text-sm">
              Group Problems
            </h4>
            {invalidGroups.map((group) => (
              <div className="flex items-start gap-3" key={group.nodeId}>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm">{group.nodeLabel}</p>
                  <ul className="mt-1 space-y-0.5 pl-3">
                    {group.problems.map((problem) => (
                      <li
                        className="text-muted-foreground text-sm"
                        key={`${problem.rule}-${problem.message}`}
                      >
                        {problem.message}
                      </li>
                    ))}
                  </ul>
                </div>
                <Button
                  aria-label={`Open ${group.nodeLabel}`}
                  className="shrink-0"
                  onClick={() => handleGoToStep(group.nodeId)}
                  size="sm"
                  variant="outline"
                >
                  Open
                </Button>
              </div>
            ))}
          </div>
        )}

        {invalidLifecycleRules.length > 0 && (
          <div className="space-y-2">
            <h4 className="font-medium text-muted-foreground text-sm">
              Lifecycle Problems
            </h4>
            {invalidLifecycleRules.map((lifecycle) => (
              <div className="flex items-start gap-3" key={lifecycle.nodeId}>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm">{lifecycle.nodeLabel}</p>
                  <ul className="mt-1 space-y-0.5 pl-3">
                    {lifecycle.problems.map((problem) => (
                      <li
                        className="text-muted-foreground text-sm"
                        key={problem.check}
                      >
                        {problem.message}
                      </li>
                    ))}
                  </ul>
                </div>
                <Button
                  aria-label={`Open ${lifecycle.nodeLabel}`}
                  className="shrink-0"
                  onClick={() => handleGoToStep(lifecycle.nodeId)}
                  size="sm"
                  variant="outline"
                >
                  Open
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
                        aria-label={`Edit ${ref.fieldLabel} in ${broken.nodeLabel}`}
                        className="shrink-0"
                        onClick={() =>
                          handleGoToStep(broken.nodeId, ref.fieldKey)
                        }
                        size="sm"
                        variant="outline"
                      >
                        Edit
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
              Fields Not Verified
            </h4>
            <div className="space-y-1 text-muted-foreground text-xs">
              <p>
                The Connection did not respond, so these fields were not
                verified.
              </p>
              <p>Reconnect the Connection in Settings to verify them again.</p>
            </div>
            {unverifiedProviderFields.map((node) => (
              <div key={node.nodeId}>
                <p className="font-medium text-sm">{node.nodeLabel}</p>
                <div className="mt-1 space-y-0.5">
                  {node.fields.map((field) => (
                    <div
                      className="flex items-center gap-3 py-0.5 pl-3"
                      key={`${node.nodeId}-${field.fieldKey}`}
                    >
                      <p className="min-w-0 flex-1 text-muted-foreground text-sm">
                        {field.fieldLabel}
                      </p>
                      <Button
                        aria-label={`Review ${field.fieldLabel} in ${node.nodeLabel}`}
                        className="shrink-0"
                        onClick={() =>
                          handleGoToStep(node.nodeId, field.fieldKey)
                        }
                        size="sm"
                        variant="outline"
                      >
                        Review
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
                        aria-label={`Edit ${field.fieldLabel} in ${node.nodeLabel}`}
                        className="shrink-0"
                        onClick={() =>
                          handleGoToStep(node.nodeId, field.fieldKey)
                        }
                        size="sm"
                        variant="outline"
                      >
                        Edit
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

function IssuesHeadline({
  issues,
  trigger,
}: {
  issues: WorkflowIssuesOverlayModel;
  trigger: WorkflowIssuesTrigger["trigger"];
}) {
  const { draftRunBlockingCount, publishBlockingCount } = issues;
  if (trigger === "publish" && publishBlockingCount > 0) {
    return (
      <IssuesSentence tone="destructive">
        Fix these issues before publishing.
      </IssuesSentence>
    );
  }
  if (draftRunBlockingCount > 0) {
    return (
      <IssuesSentence tone="destructive">
        Resolve blocking issues before running the draft.
      </IssuesSentence>
    );
  }
  if (publishBlockingCount > 0) {
    return (
      <IssuesSentence tone="warning">
        Resolve the blocking issues before publishing. The draft can still run.
      </IssuesSentence>
    );
  }
  return (
    <IssuesSentence tone="warning">
      The draft has issues that might cause the run to fail.
    </IssuesSentence>
  );
}

function IssuesSentence({
  tone,
  children,
}: {
  tone: "destructive" | "warning";
  children: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2",
        tone === "destructive" ? "text-destructive" : "text-warning"
      )}
    >
      <AlertTriangle className="size-5" />
      <p className="text-sm">{children}</p>
    </div>
  );
}
