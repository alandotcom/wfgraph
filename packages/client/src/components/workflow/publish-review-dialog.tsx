import { CircleDot, Loader2, Upload } from "lucide-react";
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
import type { PublicationReview } from "#src/lib/workflow-publication-review-store";

type PublishReviewDialogProps = {
  review: PublicationReview;
  isPublishing: boolean;
  mode: WorkflowMode;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

export type { PublicationReview } from "#src/lib/workflow-publication-review-store";

/** Removes comparison-only graph data before the review enters local UI state. */
export function publicationReviewFromComparison(
  comparison: WorkflowComparisonPayload
): PublicationReview {
  return {
    ...(comparison.baseVersion
      ? { baseVersion: comparison.baseVersion.version }
      : {}),
    proposedVersion: comparison.proposedVersion,
    nodeChanges: comparison.nodeChanges,
    edgeChanges: comparison.edgeChanges,
  };
}

/** Counts each structural category in the fixed order the review presents. */
export function publicationChangeCounts(review: PublicationReview) {
  return [
    {
      label: "Added nodes",
      count: review.nodeChanges.filter(({ kind }) => kind === "added").length,
    },
    {
      label: "Modified nodes",
      count: review.nodeChanges.filter(({ kind }) => kind === "modified")
        .length,
    },
    {
      label: "Removed nodes",
      count: review.nodeChanges.filter(({ kind }) => kind === "removed").length,
    },
    {
      label: "Added connections",
      count: review.edgeChanges.filter(({ kind }) => kind === "added").length,
    },
    {
      label: "Removed connections",
      count: review.edgeChanges.filter(({ kind }) => kind === "removed").length,
    },
  ];
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
          <dl className="grid grid-cols-2 gap-px bg-border">
            {publicationChangeCounts(review).map(({ label, count }) => (
              <div
                className="flex items-center justify-between bg-popover px-3 py-2"
                key={label}
              >
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-medium tabular-nums">{count}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Says where v{n} sends as soon as it is published. Both modes are
            worth stating, and the Live case must be read before the press
            rather than discovered from a delivered message. */}
        {/* The border and the icon carry the signal colour. The words stay in
            foreground ink, because signal text on its own tint falls under the
            contrast floor at this size (DESIGN.md, Tertiary). */}
        {mode === "test" ? (
          <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-foreground">
            <CircleDot
              aria-hidden
              className="mt-0.5 size-3.5 shrink-0 text-warning"
            />
            <p>{`Published mode is Test, so v${proposedVersion}'s Events and manual runs go to test recipients until you set it to Live.`}</p>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-foreground">
            <CircleDot
              aria-hidden
              className="mt-0.5 size-3.5 shrink-0 text-destructive"
            />
            <p>{`v${proposedVersion} will reach real recipients as soon as it is published.`}</p>
          </div>
        )}

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
