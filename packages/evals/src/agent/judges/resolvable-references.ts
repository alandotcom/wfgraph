/**
 * Every token in the finished graph is one its own node can address.
 *
 * A token naming an upstream node and a path that node does not offer passes
 * the structural checks and then resolves to nothing at run time. The way it
 * gets written is an edit above the node changing the Arriving Event after the
 * token was chosen, so the question is asked of the finished document rather
 * than of the moment each token was written.
 */

import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { brokenReferencesIn } from "@wfgraph/agent/tools/reference-diagnosis";
import type { DeterministicAssessment } from "#src/agent/assessment";
import type { AgentEvalDocument } from "#src/agent/result";

export function assessResolvableReferences(input: {
  readonly document: AgentEvalDocument;
  readonly catalog: ExtensionCatalog;
}): DeterministicAssessment {
  const broken = brokenReferencesIn({
    document: input.document,
    catalog: input.catalog,
  });

  if (broken.length === 0) {
    return {
      score: 1,
      rationale: "Every reference in the graph names a path its node can read.",
    };
  }

  const named = broken
    .map(
      (reference) =>
        `${reference.nodeLabel}.${reference.configKey} holds ${reference.token}`
    )
    .join("; ");

  return {
    score: 0,
    rationale: `${broken.length} reference${broken.length === 1 ? "" : "s"} cannot be read by the node holding them: ${named}.`,
  };
}
