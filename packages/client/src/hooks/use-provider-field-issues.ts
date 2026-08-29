/**
 * The nodes whose provider-backed fields are missing a value the provider needs.
 *
 * A `provider-fields` field draws one input per value the chosen resource
 * declares, and which of those the provider has no default for is the
 * connection's answer rather than anything the catalog knows. So the shared
 * collector cannot raise these, and this asks the same question the config panel
 * asks, for every node rather than only the open one.
 *
 * An unanswered question raises nothing. Absence of an answer is not evidence a
 * value is missing, and accusing a node while its query is in flight would flag
 * the whole canvas on every load. That is the same rule the collector already
 * applies to the connection list. A refused answer is left silent here for the
 * same reason: a provider that blinks would badge the canvas. The click-time
 * recheck behind Run and Publish is where a refusal is worth saying out loud,
 * and `fetchProviderFieldIssues` raises it there.
 */

import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { configOptionsQueryOptions } from "#src/lib/rpc-query";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { MissingRequiredFieldIssue } from "@wfgraph/shared/graph/workflow-issues";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import {
  providerFieldIssuesFor,
  providerFieldQuestions,
} from "#src/lib/provider-field-issues";

export function useProviderFieldIssues(
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): MissingRequiredFieldIssue[] {
  const questions = useMemo(
    () => providerFieldQuestions(nodes, catalog),
    [nodes, catalog]
  );

  const answers = useQueries({
    queries: questions.map((question) =>
      configOptionsQueryOptions({
        integrationId: question.integrationId,
        provider: question.provider,
        parameters: question.parameters,
      })
    ),
  });

  // `useQueries` answers a new array every render, so the memo below is keyed on
  // what the answers say rather than on the array holding them.
  const answered = answers.map((answer) => answer.data);
  const answerKey = JSON.stringify(answered);

  return useMemo(
    () =>
      questions.flatMap((question, index) =>
        providerFieldIssuesFor(question, answered[index])
      ),
    // eslint-disable-next-line react-hooks-js/exhaustive-deps -- `answerKey` stands for `answered`, which is rebuilt every render
    [questions, answerKey]
  );
}
