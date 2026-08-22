/**
 * Draft-vs-published status for the open workflow.
 *
 * Driven by the publication digest on `getById`, not the save queue. Kept as its
 * own component so the badge's three states can be tested through props without
 * standing up the rest of the toolbar.
 */

type WorkflowPublicationBadgeProps = {
  isPublished: boolean;
  hasUnpublishedChanges: boolean;
};

export function WorkflowPublicationBadge({
  isPublished,
  hasUnpublishedChanges,
}: WorkflowPublicationBadgeProps) {
  // Answers "is the draft what is running", which nothing on this screen said
  // once the publish toast faded. Worded away from "Live" on purpose: that word
  // already names the run mode two controls to the right, and two meanings for
  // it read as one switch.
  if (!isPublished) {
    return <Token color="gray" label="Never published" size="sm" />;
  }

  return (
    <Token
      color={hasUnpublishedChanges ? "yellow" : "green"}
      label={hasUnpublishedChanges ? "Unpublished changes" : "Published"}
      size="sm"
    />
  );
}
import { Token } from "@astryxdesign/core/Token";
