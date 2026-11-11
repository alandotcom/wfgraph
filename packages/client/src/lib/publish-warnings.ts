/**
 * What the editor says about a warning a confirmed Publish answered with. A
 * warning never stops a Publish, so the editor shows it beside the success it
 * reports rather than in place of it.
 */

import type { WorkflowPublishWarning } from "@wfgraph/shared/graph/publication-contracts";

/** A toast's headline and its supporting sentence. */
export type PublishWarningMessage = { title: string; description: string };

function runs(count: number): string {
  return count === 1 ? "1 run" : `${count} runs`;
}

/** The headline and description the editor shows for one publish warning. */
export function publishWarningMessage(
  warning: WorkflowPublishWarning
): PublishWarningMessage {
  const form = warning.tracksEntity
    ? "This version tracks an Entity"
    : "This version no longer tracks an Entity";
  const count = warning.inFlightRuns;
  const identify =
    count === 1 ? "identifies its Entity" : "identify their Entity";
  const how = warning.tracksEntity
    ? "by its Correlation Path value"
    : "by its type and ID";
  return {
    title: `${runs(count)} started by an earlier version`,
    description: `${form}. The ${runs(count)} still in flight from an earlier version ${identify} ${how}, so ${count === 1 ? "it finishes" : "they finish"} on that version and cannot be migrated. Cancel Events and Concurrency still reach ${count === 1 ? "it" : "them"}.`,
  };
}
