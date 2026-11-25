import { useQuery } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import { AlertTriangle, Pencil } from "lucide-react";
import { Button } from "#src/components/ui/button";
import { publicationLabel } from "#src/components/workflow/workflow-publication-badge";
import { workflowIssuesLabel } from "#src/components/workflow/workflow-issues-chip";
import { useGoToStep } from "#src/hooks/use-workflow-issues";
import { can } from "#src/lib/authorization";
import { orpcQuery } from "#src/lib/rpc-query";
import type { WorkflowApiPayload } from "@wfgraph/shared/graph/api-contracts";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import { publishedModeWord } from "#src/lib/workflow-run-labels";
import {
  currentWorkflowIdAtom,
  currentWorkflowModeAtom,
  currentWorkflowNameAtom,
} from "#src/lib/workflow-save-store";
import { openRenameWorkflowDialogAtom } from "#src/lib/workflow-ui-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { isBlank } from "@wfgraph/shared/types/string";
import { cn } from "@wfgraph/shared/utils";
import { compact } from "es-toolkit/array";

/** What the panel reads off the workflow's `getById` payload. */
function selectWorkflowFacts(payload: WorkflowApiPayload) {
  return {
    description: payload.description,
    publication: publicationLabel({
      isPublished: Boolean(payload.publishedVersionId),
      hasUnpublishedChanges: payload.hasUnpublishedChanges,
      publishedVersion: payload.publishedVersion,
    }),
    isPaused: payload.isPaused,
  };
}

/**
 * The workflow's description and publication state, from the `getById` entry
 * the editor already holds, so this reads no request of its own.
 */
function useWorkflowFacts(workflowId: string | null) {
  return useQuery({
    ...orpcQuery.workflow.getById.queryOptions({
      input: { workflowId: workflowId ?? "" },
    }),
    enabled: workflowId !== null,
    staleTime: Number.POSITIVE_INFINITY,
    select: selectWorkflowFacts,
  }).data;
}

/**
 * The Details tab with nothing selected in Draft: the workflow's name and
 * description, its publication state and Published mode, and its issues. Each
 * issue's Edit selects the step it names and puts the cursor in the field the
 * issue names.
 */
export function WorkflowDetails() {
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const name = useAtomValue(currentWorkflowNameAtom);
  const mode = useAtomValue(currentWorkflowModeAtom);
  const issues = useAtomValue(workflowIssuesAtom);
  const openRename = useSetAtom(openRenameWorkflowDialogAtom);
  const goToStep = useGoToStep();
  const facts = useWorkflowFacts(workflowId);
  const canUpdate = can(WfGraphOperations.workflowUpdate.id);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain bg-card px-4 py-3 [scrollbar-gutter:stable]"
      data-slot="workflow-details"
    >
      <section aria-labelledby="workflow-details-name" className="space-y-1">
        <div className="flex items-start gap-2">
          <h2
            className="min-w-0 flex-1 break-words font-semibold text-sm"
            id="workflow-details-name"
          >
            {isBlank(name) ? "Untitled workflow" : name}
          </h2>
          {canUpdate ? (
            <Button
              onClick={openRename}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Pencil />
              Rename
            </Button>
          ) : null}
        </div>
        {facts?.description && !isBlank(facts.description) ? (
          <p className="text-muted-foreground text-xs">{facts.description}</p>
        ) : null}
        {facts ? (
          <p className="text-muted-foreground text-xs">
            {compact([
              facts.publication,
              `Published mode: ${publishedModeWord(mode)}`,
              facts.isPaused ? "Paused" : null,
            ]).join(" · ")}
          </p>
        ) : null}
      </section>
      <section aria-labelledby="workflow-details-issues" className="space-y-2">
        <h3
          className="font-medium text-muted-foreground text-xs"
          id="workflow-details-issues"
        >
          {issues.length === 0 ? "Issues" : workflowIssuesLabel(issues.length)}
        </h3>
        {issues.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            This workflow has no issues.
          </p>
        ) : (
          <ul className="space-y-1">
            {issues.map((issue) => (
              <li
                className="flex items-start gap-2 rounded-md py-1 text-xs"
                key={`${issue.kind}:${issue.nodeId}:${"fieldKey" in issue ? issue.fieldKey : ""}:${issue.message}`}
              >
                <AlertTriangle
                  aria-hidden
                  className={cn(
                    "mt-0.5 size-3 shrink-0",
                    issue.severity === "blocking"
                      ? "text-warning"
                      : "text-muted-foreground"
                  )}
                />
                <p className="min-w-0 flex-1">
                  <span className="font-medium">{issue.nodeLabel}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    {issue.message}
                  </span>
                </p>
                {canUpdate ? (
                  <Button
                    aria-label={`Edit ${issue.nodeLabel}`}
                    onClick={() =>
                      goToStep(
                        issue.nodeId,
                        "fieldKey" in issue ? issue.fieldKey : undefined
                      )
                    }
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Edit
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
