import { useQuery } from "@tanstack/react-query";
import { uniq } from "es-toolkit/array";
import { useAtomValue } from "jotai";
import { Circle, Loader2, Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#src/components/ui/dialog";
import { Button } from "#src/components/ui/button";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { ComparisonMarker } from "#src/components/flow-elements/comparison-marker";
import {
  changedNodeTitle,
  comparisonFields,
} from "#src/components/workflow/comparison-properties";
import { useWorkflowComparisonActions } from "#src/components/workflow/use-workflow-comparison-actions";
import { useWorkflowWorkspaceNavigation } from "#src/hooks/use-workflow-workspace-navigation";
import { can } from "#src/lib/authorization";
import { isSubmitChord } from "#src/lib/editor-shortcuts";
import { orpcQuery } from "#src/lib/rpc-query";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { COMPARISON_CHANGE_KIND_LABEL } from "#src/lib/workflow-graph-types";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { classifyWorkflowComparison } from "@wfgraph/shared/graph/change-classification";
import type {
  WorkflowComparisonPayload,
  WorkflowNodeChange,
  WorkflowVersionUsageItem,
} from "@wfgraph/shared/graph/publication-contracts";
import type { WorkflowMode } from "@wfgraph/shared/graph/types";
import {
  comparisonSummary,
  ORGANIZATION_ONLY_STATEMENT,
} from "#src/lib/workflow-change-summary";
import type { PublicationReview } from "#src/lib/workflow-publication-review-store";
import { cn } from "@wfgraph/shared/utils";

type PublishReviewDialogProps = {
  review: PublicationReview;
  isPublishing: boolean;
  mode: WorkflowMode;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

export type { PublicationReview } from "#src/lib/workflow-publication-review-store";

/**
 * The review of a comparison: its version numbers, its changes, and the
 * redacted graphs those changes are classified against.
 */
export function publicationReviewFromComparison(
  comparison: WorkflowComparisonPayload
): PublicationReview {
  return {
    baseVersion: comparison.baseVersion
      ? comparison.baseVersion.version
      : undefined,
    proposedVersion: comparison.proposedVersion,
    baseGraph: comparison.baseGraph,
    draftGraph: comparison.draftGraph,
    nodeChanges: comparison.nodeChanges,
    edgeChanges: comparison.edgeChanges,
  };
}

/** A label and value row of the publication summary. */
function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 bg-popover px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

/**
 * The review's counts under Behavior and Organization, as Changes Browse shows
 * them. A review whose only changes are Group organization says that execution
 * behavior is unchanged in place of the Behavior counts.
 */
function PublicationSummary({ review }: { review: PublicationReview }) {
  const summary = comparisonSummary(review);
  const heading =
    "border-b bg-muted/30 px-3 py-1.5 font-medium text-muted-foreground text-xs";
  return (
    <>
      <section aria-label="Behavior changes">
        <h3 className={heading}>Behavior</h3>
        {summary.behavior ? (
          <dl className="grid gap-px bg-border">
            <SummaryRow label="Steps" value={summary.behavior.steps} />
            <SummaryRow
              label="Connections"
              value={summary.behavior.connections}
            />
          </dl>
        ) : (
          <p className="px-3 py-2" data-state="behavior-unchanged">
            {ORGANIZATION_ONLY_STATEMENT}
          </p>
        )}
      </section>
      {summary.organization ? (
        <section aria-label="Organization changes" className="border-t">
          <h3 className={heading}>Organization</h3>
          <dl className="grid gap-px bg-border">
            <SummaryRow label="Groups" value={summary.organization.groups} />
            <SummaryRow
              label="Group membership"
              value={summary.organization.membership}
            />
          </dl>
        </section>
      ) : null}
    </>
  );
}

/** One changed step a publication releases, as the dialog lists it. */
type ReleasedStep = {
  nodeId: string;
  change: WorkflowNodeChange["kind"];
  title: string;
  /**
   * What changed: the names of a modified step's changed settings, "Group
   * membership" for a step that only moved between Groups, and otherwise the
   * kind of change.
   */
  detail: string;
};

/**
 * The steps `review` adds, modifies, or removes, by name, in the order the
 * comparison lists them. Group frames are counted under Organization and are
 * not listed.
 */
function releasedSteps(
  catalog: ExtensionCatalog,
  review: PublicationReview
): ReleasedStep[] {
  const categories = classifyWorkflowComparison(review);
  return review.nodeChanges
    .filter((change) => !categories.groupFrameIds.has(change.nodeId))
    .map((change) => {
      const settings =
        change.kind === "modified"
          ? uniq(
              comparisonFields(catalog, review, change)
                .filter((field) => field.category === "behavior")
                .map((field) => field.label)
            )
          : [];
      const detail =
        change.kind !== "modified"
          ? COMPARISON_CHANGE_KIND_LABEL[change.kind]
          : categories.nodes.get(change.nodeId)?.behavior === false
            ? "Group membership"
            : settings.length > 0
              ? settings.join(", ")
              : COMPARISON_CHANGE_KIND_LABEL.modified;
      return {
        nodeId: change.nodeId,
        change: change.kind,
        title: changedNodeTitle(catalog, review, change),
        detail,
      };
    });
}

/**
 * The changed steps by name, each with its change marker and what changed, so
 * the person publishing can check every change that goes out. A long list
 * scrolls inside the dialog.
 */
function ReleasedStepList({ review }: { review: PublicationReview }) {
  const catalog = useExtensionCatalog();
  const steps = releasedSteps(catalog, review);
  if (steps.length === 0) return null;
  return (
    <section aria-label="Changed steps" className="border-t">
      <h3 className="border-b bg-muted/30 px-3 py-1.5 font-medium text-muted-foreground text-xs">
        Changed steps
      </h3>
      <ul className="max-h-40 divide-y overflow-y-auto">
        {steps.map((step) => (
          <li
            className="flex items-center gap-2 bg-popover px-3 py-2"
            key={step.nodeId}
          >
            <ComparisonMarker
              className="static shrink-0"
              comparison={{ kind: step.change }}
            />
            <span className="min-w-0 flex-1 truncate font-medium">
              <span className="sr-only">
                {COMPARISON_CHANGE_KIND_LABEL[step.change]}:{" "}
              </span>
              {step.title}
            </span>
            <span className="min-w-0 max-w-1/2 shrink-0 truncate text-muted-foreground">
              {step.detail}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The sentence naming how many active runs stay on published versions once a
 * new one is published, or null when none does. Every published version is
 * older than the one being published, and a Draft run's snapshot is never
 * published, so it is not counted.
 */
export function runsLeftOnOlderVersions(
  items: readonly WorkflowVersionUsageItem[]
): string | null {
  const pinned = items.filter(
    (item) => item.kind === "published" && item.activeRunCount > 0
  );
  const runs = pinned.reduce((count, item) => count + item.activeRunCount, 0);
  if (runs === 0) return null;
  const versions = pinned
    .map((item) => item.version)
    .filter((version) => version !== null)
    .toSorted((left, right) => left - right);
  const named =
    versions.length === 1
      ? `version ${versions[0]}`
      : `versions ${new Intl.ListFormat("en", { type: "conjunction" }).format(
          versions.map(String)
        )}`;
  return `${runs} active ${runs === 1 ? "run stays" : "runs stay"} on ${named}.`;
}

/**
 * How many active runs stay on older versions after this publish, with a link
 * to version history's In use section, where those runs can be migrated. It
 * shows nothing while the count loads, when the person cannot read version
 * usage or the read fails, and when no run is active.
 */
function RunsLeftBehind({ onShowUsage }: { onShowUsage: () => void }) {
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const canReadUsage = can(WfGraphOperations.workflowGetVersionUsage.id);
  const usage = useQuery({
    ...orpcQuery.workflow.getVersionUsage.queryOptions({
      input: { workflowId: workflowId ?? "" },
    }),
    enabled: Boolean(workflowId) && canReadUsage,
    staleTime: 30_000,
  });
  const sentence = canReadUsage
    ? runsLeftOnOlderVersions(usage.data?.items ?? [])
    : null;
  if (sentence === null) return null;
  return (
    <p className="text-muted-foreground">
      {sentence}{" "}
      <Button
        className="h-auto px-0 align-baseline"
        onClick={onShowUsage}
        type="button"
        variant="link"
      >
        Show version usage
      </Button>
    </p>
  );
}

/** Confirms publication using structural facts the comparison service already redacted. */
export function PublishReviewDialog({
  review,
  isPublishing,
  mode,
  onConfirm,
  onOpenChange,
  open,
}: PublishReviewDialogProps) {
  const proposedVersion = review.proposedVersion;
  const comparisonActions = useWorkflowComparisonActions();
  const { showVersionHistory } = useWorkflowWorkspaceNavigation(
    comparisonActions.openComparison
  );

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!isPublishing) {
          onOpenChange(nextOpen);
        }
      }}
      open={open}
    >
      <DialogContent
        className="sm:max-w-lg"
        // Cmd+Enter publishes from anywhere in the dialog, as its button does.
        onKeyDown={(event) => {
          if (isSubmitChord(event) && !isPublishing) {
            event.preventDefault();
            event.stopPropagation();
            onConfirm();
          }
        }}
        showCloseButton={!isPublishing}
      >
        <DialogHeader>
          <DialogTitle>Publish v{proposedVersion}?</DialogTitle>
          <DialogDescription>
            New starts will use v{proposedVersion}. Existing runs remain pinned
            to the version they started with.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-hidden rounded-lg border">
          <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2 text-xs">
            <span>
              {review.baseVersion
                ? `Based on v${review.baseVersion}`
                : "No published version"}
            </span>
            <span className="text-muted-foreground">
              Proposed v{proposedVersion}
            </span>
          </div>
          <PublicationSummary review={review} />
          <ReleasedStepList review={review} />
        </div>

        <RunsLeftBehind
          onShowUsage={() => {
            onOpenChange(false);
            showVersionHistory();
          }}
        />

        {/* Says where v{n} sends as soon as it is published. Both modes are
            worth stating, and the Live case must be read before the press
            rather than discovered from a delivered message. One plain line
            either way: the fact is the same size in both modes, and a box
            around it would rank one press as more dangerous than the other. */}
        <p className="flex items-start gap-2 text-muted-foreground">
          {/* The same dot the status strip's Published mode control wears:
              filled and Amber for Test, an outline in muted ink for Live, so
              the mode is legible without reading the sentence. Amber marks Test
              and nothing else, and it stays on the dot rather than the whole
              line, which keeps the sentence above the 4.5:1 body floor. */}
          <Circle
            aria-hidden
            className={cn(
              "mt-1 size-2.5 shrink-0",
              mode === "test" && "fill-current text-warning"
            )}
          />
          {mode === "test"
            ? `Published mode is Test. v${proposedVersion} sends to test recipients until you switch to Live.`
            : `Published mode is Live. v${proposedVersion} sends to real recipients as soon as you publish.`}
        </p>

        <DialogFooter>
          <Button
            disabled={isPublishing}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={isPublishing} onClick={onConfirm}>
            {isPublishing ? (
              <Loader2
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
              />
            ) : (
              <Upload data-icon="inline-start" />
            )}
            {isPublishing ? "Publishing" : `Publish v${proposedVersion}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
