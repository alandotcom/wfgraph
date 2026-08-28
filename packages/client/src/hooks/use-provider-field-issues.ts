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
 * applies to the connection list.
 */

import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ConfigOptionsAnswer } from "#src/lib/rpc-client";
import { configOptionsQueryOptions } from "#src/lib/rpc-query";
import {
  type ExtensionCatalog,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import {
  readProviderParameters,
  settledProviderParameter,
} from "#src/lib/provider-parameters";
import {
  hasProviderFieldValue,
  type ProviderFieldValues,
  readProviderFieldValues,
} from "@wfgraph/shared/plugins/provider-field-values";
import {
  type MissingRequiredFieldIssue,
  workflowNodeLabel,
} from "@wfgraph/shared/graph/workflow-issues";
import {
  type ActionConfigFieldBase,
  flattenConfigFields,
} from "@wfgraph/shared/plugins/action-fields";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { readConfigTrimmedString } from "@wfgraph/shared/graph/node-config";

/** One question a node's provider-backed field needs answered to be judged. */
type FieldQuestion = {
  readonly nodeId: string;
  readonly nodeLabel: string;
  readonly field: ActionConfigFieldBase;
  readonly integrationId: string;
  readonly provider: string;
  readonly parameters: Record<string, string>;
  readonly stored: string;
};

function questionsFor(
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): FieldQuestion[] {
  const questions: FieldQuestion[] = [];

  for (const node of nodes) {
    if (node.data.type !== "action" || node.data.enabled === false) {
      continue;
    }
    const config = node.data.config ?? {};
    const actionType = settledProviderParameter(config.actionType);
    if (!actionType) {
      continue;
    }
    const action = findAction(catalog, actionType);
    const integrationId = settledProviderParameter(config.integrationId);
    if (!action || !integrationId) {
      continue;
    }

    for (const field of flattenConfigFields(action.configFields)) {
      const source = field.optionsSource;
      if (field.type !== "provider-fields" || !source) {
        continue;
      }

      // A node whose parameters have not settled is asked nothing, so it is
      // judged by nothing. That is the same gate the config panel applies.
      const { parameters, missing } = readProviderParameters(source, config);
      if (missing.length > 0) {
        continue;
      }

      questions.push({
        nodeId: node.id,
        nodeLabel: workflowNodeLabel({
          node,
          actionLabel: action.label,
          actionType,
        }),
        field,
        integrationId,
        provider: source.provider,
        parameters,
        stored: readConfigTrimmedString(config, field.key) ?? "",
      });
    }
  }

  return questions;
}

/** The values this node already holds for that field, or nothing if unreadable. */
function storedValues(text: string): ProviderFieldValues | null {
  // Nothing stored is every required variable missing, which is the whole point
  // of the check. Anything the form itself cannot read is handled below.
  if (text.trim().length === 0) {
    return {};
  }
  return readProviderFieldValues(text);
}

function issuesFor(
  question: FieldQuestion,
  answer: ConfigOptionsAnswer | undefined
): MissingRequiredFieldIssue[] {
  if (!answer || answer.status !== "fields") {
    return [];
  }

  const values = storedValues(question.stored);
  if (!values) {
    // Text this form cannot read is the builder's own edit, and the panel hands
    // it back to them as a textarea. Judging it would be guessing.
    return [];
  }

  return answer.fields
    .filter(
      (entry) =>
        entry.required === true && !hasProviderFieldValue(values, entry.key)
    )
    .map((entry) => ({
      kind: "missing_required_field" as const,
      severity: "blocking" as const,
      nodeId: question.nodeId,
      nodeLabel: question.nodeLabel,
      // The sub-input's own id, which is what `useGoToStep` puts the cursor in:
      // the ready form renders one input per variable under this exact key, and
      // the parent key belongs to the fallback textarea the form replaced. It is
      // also what keeps two missing variables on one node distinct in the issues
      // list, which groups by node and keys its rows on this.
      fieldKey: `${question.field.key}.${entry.key}`,
      fieldLabel: `${question.field.label} · ${entry.label}`,
      message: `Node "${question.nodeLabel}" is missing required field "${question.field.label} · ${entry.label}"`,
    }));
}

export function useProviderFieldIssues(
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): MissingRequiredFieldIssue[] {
  const questions = useMemo(
    () => questionsFor(nodes, catalog),
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
        issuesFor(question, answered[index])
      ),
    // eslint-disable-next-line react-hooks-js/exhaustive-deps -- `answerKey` stands for `answered`, which is rebuilt every render
    [questions, answerKey]
  );
}
