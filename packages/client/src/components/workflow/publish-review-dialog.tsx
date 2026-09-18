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
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
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

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!isPublishing) {
          onOpenChange(nextOpen);
        }
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-lg" showCloseButton={!isPublishing}>
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
        </div>

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
