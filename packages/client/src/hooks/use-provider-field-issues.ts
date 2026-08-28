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
import { type JsonObject, readJsonObject } from "@wfgraph/shared/types/json";
import { configOptionsQueryOptions } from "#src/lib/rpc-query";
import {
  type ExtensionCatalog,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
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

/** A value usable as a provider parameter: present, and not a node reference. */
function settled(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || findTemplateTokens(trimmed).length > 0) {
    return undefined;
  }
  return trimmed;
}

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
    const actionType = settled(config.actionType);
    if (!actionType) {
      continue;
    }
    const action = findAction(catalog, actionType);
    const integrationId = settled(config.integrationId);
    if (!action || !integrationId) {
      continue;
    }

    for (const field of flattenConfigFields(action.configFields)) {
      const source = field.optionsSource;
      if (field.type !== "provider-fields" || !source) {
        continue;
      }

      const parameters: Record<string, string> = {};
      let askable = true;
      for (const key of source.parameters ?? []) {
        const value = settled(config[key]);
        if (value === undefined) {
          askable = false;
          break;
        }
        parameters[key] = value;
      }
      if (!askable) {
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
function storedValues(text: string): JsonObject | null {
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return readJsonObject(JSON.parse(text));
  } catch {
    return null;
  }
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
    .filter((entry) => {
      if (entry.required !== true) {
        return false;
      }
      const value = values[entry.key];
      return typeof value !== "string" || value.trim().length === 0;
    })
    .map((entry) => ({
      kind: "missing_required_field" as const,
      severity: "blocking" as const,
      nodeId: question.nodeId,
      nodeLabel: question.nodeLabel,
      // The parent key, because that is the field the editor can put a cursor
      // in; the variable's own name goes in the label a reader sees.
      fieldKey: question.field.key,
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
