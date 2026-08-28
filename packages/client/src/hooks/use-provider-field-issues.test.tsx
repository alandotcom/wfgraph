/**
 * A node whose template needs a value it does not have is a node that cannot
 * run, so it has to reach the same list the badge and the publish gate read.
 * Saying so only in the open config panel let an invalid workflow be published.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useProviderFieldIssues } from "#src/hooks/use-provider-field-issues";
import type { ConfigOptionsAnswer } from "#src/lib/rpc-client";
import { configOptionsQueryOptions } from "#src/lib/rpc-query";
import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { hasBlockingWorkflowIssues } from "@wfgraph/shared/graph/workflow-issues";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";

const catalog: ExtensionCatalog = {
  ...emptyExtensionCatalog,
  actions: [
    {
      id: "resend/send-email",
      label: "Send Email",
      description: "Sends an email",
      category: "Resend",
      integration: "resend",
      sideEffect: true,
      configFields: [
        {
          key: "emailTemplateId",
          label: "Template",
          type: "provider-select",
          optionsSource: { provider: "templates" },
        },
        {
          key: "emailTemplateVariables",
          label: "Template Variables",
          type: "provider-fields",
          optionsSource: {
            provider: "template-variables",
            parameters: ["emailTemplateId"],
          },
        },
      ],
      outputFields: [],
    },
  ],
};

function node(config: Record<string, unknown>): WorkflowNode {
  return {
    id: "n1",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      type: "action",
      label: "Send Email",
      config: {
        actionType: "resend/send-email",
        integrationId: "int_1",
        ...config,
      },
    },
  } as WorkflowNode;
}

const variablesAnswer: ConfigOptionsAnswer = {
  status: "fields",
  fields: [
    { key: "DONOR_FIRST_NAME", label: "DONOR_FIRST_NAME", required: true },
    { key: "CITY", label: "CITY", defaultValue: "Burbank" },
  ],
};

function collect(options: {
  nodes: readonly WorkflowNode[];
  answer?: ConfigOptionsAnswer;
  templateId?: string;
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  if (options.answer) {
    queryClient.setQueryData(
      configOptionsQueryOptions({
        integrationId: "int_1",
        provider: "template-variables",
        parameters: { emailTemplateId: options.templateId ?? "tpl_1" },
      }).queryKey,
      options.answer
    );
  }

  return renderHook(() => useProviderFieldIssues(options.nodes, catalog), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  }).result.current;
}

describe("issues a provider-backed field raises", () => {
  it("flags a required variable the node has no value for", () => {
    const issues = collect({
      nodes: [node({ emailTemplateId: "tpl_1" })],
      answer: variablesAnswer,
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: "missing_required_field",
      severity: "blocking",
      nodeId: "n1",
      // The parent key, so opening the issue puts the cursor on the field that
      // holds them; the variable's own name is in the label.
      fieldKey: "emailTemplateVariables",
      fieldLabel: "Template Variables · DONOR_FIRST_NAME",
    });
    // Blocking is what stops the publish this used to let through.
    expect(hasBlockingWorkflowIssues(issues)).toBe(true);
  });

  it("says nothing once the value is there", () => {
    const issues = collect({
      nodes: [
        node({
          emailTemplateId: "tpl_1",
          emailTemplateVariables: JSON.stringify({ DONOR_FIRST_NAME: "Ada" }),
        }),
      ],
      answer: variablesAnswer,
    });

    expect(issues).toEqual([]);
  });

  it("never flags a variable the template has a default for", () => {
    const issues = collect({
      nodes: [
        node({
          emailTemplateId: "tpl_1",
          emailTemplateVariables: JSON.stringify({ DONOR_FIRST_NAME: "Ada" }),
        }),
      ],
      answer: variablesAnswer,
    });

    expect(issues.some((issue) => issue.fieldLabel.includes("CITY"))).toBe(
      false
    );
  });

  it("accuses nothing while the connection has not answered", () => {
    // Absence of an answer is not evidence a value is missing, and flagging the
    // canvas on every load would be worse than flagging it late.
    const issues = collect({ nodes: [node({ emailTemplateId: "tpl_1" })] });

    expect(issues).toEqual([]);
  });

  it("asks nothing for a node with no template chosen", () => {
    const issues = collect({ nodes: [node({})], answer: variablesAnswer });

    expect(issues).toEqual([]);
  });

  it("leaves a hand-written value to the builder", () => {
    const issues = collect({
      nodes: [
        node({
          emailTemplateId: "tpl_1",
          emailTemplateVariables: "not json at all",
        }),
      ],
      answer: variablesAnswer,
    });

    // The panel hands text it cannot read back as a textarea, so judging it here
    // would be guessing at what the builder meant.
    expect(issues).toEqual([]);
  });

  it("says nothing about a disabled node", () => {
    const disabled = node({ emailTemplateId: "tpl_1" });

    const issues = collect({
      nodes: [
        {
          ...disabled,
          data: { ...disabled.data, enabled: false },
        } as WorkflowNode,
      ],
      answer: variablesAnswer,
    });

    expect(issues).toEqual([]);
  });
});
