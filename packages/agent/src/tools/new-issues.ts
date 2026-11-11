/**
 * The validation issues a write introduced: what the draft reports after the
 * write and did not report before it. Every write tool answers them, so a
 * caller learns what an edit left to fix without a validate_workflow call
 * after each step. An issue the draft already had is left out, because a
 * graph mid-build carries half-finished steps and repeating them on every
 * write would bury the one the write caused.
 */

import { Schema } from "effect";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import type { AgentDraftValidation, AgentValidationIssue } from "#src/document";

const newIssueSchema = Schema.Struct({
  blocksPublish: Schema.Boolean,
  kind: Schema.String,
  nodeId: Schema.optionalKey(Schema.String),
  nodeLabel: Schema.optionalKey(Schema.String),
  message: Schema.String,
});

export type NewIssue = typeof newIssueSchema.Type;

/** The field each write tool's success schema carries. */
export const newIssuesField = {
  newIssues: Schema.optionalKey(Schema.Array(newIssueSchema)).annotate({
    description:
      "Validation issues this write introduced, absent when it introduced none. blocksPublish is true for an issue that stops publication or saving.",
  }),
};

function fromIssue(
  issue: AgentValidationIssue,
  blocksPublish: boolean
): NewIssue {
  return omitUndefined({
    blocksPublish,
    kind: issue.kind,
    nodeId: issue.nodeId,
    nodeLabel: issue.nodeLabel,
    message: issue.message,
  });
}

/** Every issue a validation reports, as one list. */
function issuesOf(validation: AgentDraftValidation): NewIssue[] {
  return [
    ...validation.structuralIssues.map((message) => ({
      blocksPublish: true,
      kind: "structure",
      message,
    })),
    ...validation.publishBlockers.map((issue) => fromIssue(issue, true)),
    ...validation.warnings.map((issue) => fromIssue(issue, false)),
  ];
}

function keyOf(issue: NewIssue): string {
  return JSON.stringify([issue.kind, issue.nodeId ?? "", issue.message]);
}

/** The issues `after` reports that `before` did not. */
export function issuesIntroduced(input: {
  readonly before: AgentDraftValidation;
  readonly after: AgentDraftValidation;
}): NewIssue[] {
  const already = new Set(issuesOf(input.before).map(keyOf));
  return issuesOf(input.after).filter((issue) => !already.has(keyOf(issue)));
}
