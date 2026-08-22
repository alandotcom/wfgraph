/**
 * Draft-vs-published status for the open workflow.
 *
 * Driven by the publication digest on `getById`, not the save queue. Kept as its
 * own component so the badge's three states can be tested through props without
 * standing up the rest of the status strip.
 */

type WorkflowPublicationBadgeProps = {
  isPublished: boolean;
  hasUnpublishedChanges: boolean;
};

/**
 * Answers "is the draft what is running", which nothing on this screen said
 * once the publish toast faded.
 *
 * Worded away from "Live" on purpose: that word already names the run mode, and
 * the strip now prints the two of them inches apart, so a second meaning for it
 * would read as one switch.
 */
export function publicationLabel({
  isPublished,
  hasUnpublishedChanges,
}: WorkflowPublicationBadgeProps): string {
  if (!isPublished) {
    return "Never published";
  }
  return hasUnpublishedChanges ? "Unpublished changes" : "Published";
}

export function WorkflowPublicationBadge(props: WorkflowPublicationBadgeProps) {
  return (
    <span className="shrink-0 whitespace-nowrap">
      {publicationLabel(props)}
    </span>
  );
}
