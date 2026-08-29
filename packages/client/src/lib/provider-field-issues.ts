import type { QueryClient } from "@tanstack/react-query";
import type { ConfigOptionsAnswer } from "#src/lib/rpc-client";
import { configOptionsQueryOptions } from "#src/lib/rpc-query";
import {
  readProviderParameters,
  settledProviderParameter,
} from "#src/lib/provider-parameters";
import {
  type ExtensionCatalog,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import { readConfigTrimmedString } from "@wfgraph/shared/graph/node-config";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import {
  type MissingRequiredFieldIssue,
  workflowNodeLabel,
} from "@wfgraph/shared/graph/workflow-issues";
import {
  type ActionConfigFieldBase,
  flattenConfigFields,
} from "@wfgraph/shared/plugins/action-fields";
import {
  hasProviderFieldValue,
  type ProviderFieldValues,
  readProviderFieldValues,
} from "@wfgraph/shared/plugins/provider-field-values";

/** One question a node's provider-backed field needs answered to be judged. */
type ProviderFieldQuestion = {
  readonly nodeId: string;
  readonly nodeLabel: string;
  readonly field: ActionConfigFieldBase;
  readonly integrationId: string;
  readonly provider: string;
  readonly parameters: Record<string, string>;
  readonly stored: string;
};

export function providerFieldQuestions(
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): ProviderFieldQuestion[] {
  const questions: ProviderFieldQuestion[] = [];

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
  if (text.trim().length === 0) {
    return {};
  }
  return readProviderFieldValues(text);
}

export function providerFieldIssuesFor(
  question: ProviderFieldQuestion,
  answer: ConfigOptionsAnswer | undefined
): MissingRequiredFieldIssue[] {
  if (!answer || answer.status !== "fields") {
    return [];
  }

  const values = storedValues(question.stored);
  if (!values) {
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
      fieldKey: `${question.field.key}.${entry.key}`,
      fieldLabel: `${question.field.label} · ${entry.label}`,
      message: `Node "${question.nodeLabel}" is missing required field "${question.field.label} · ${entry.label}"`,
    }));
}

/** Fetch and judge every provider-backed field from one exact graph snapshot. */
export async function fetchProviderFieldIssues(
  queryClient: QueryClient,
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): Promise<MissingRequiredFieldIssue[]> {
  const questions = providerFieldQuestions(nodes, catalog);
  const answers = await Promise.all(
    questions.map((question) =>
      queryClient.fetchQuery({
        ...configOptionsQueryOptions({
          integrationId: question.integrationId,
          provider: question.provider,
          parameters: question.parameters,
        }),
        staleTime: 0,
      })
    )
  );

  return questions.flatMap((question, index) =>
    providerFieldIssuesFor(question, answers[index])
  );
}
