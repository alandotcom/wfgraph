/**
 * A node whose template needs a value it does not have is a node that cannot
 * run, so it has to reach the same list the badge and the publish gate read.
 * Saying so only in the open config panel let an invalid workflow be published.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProviderFieldIssues } from "#src/hooks/use-provider-field-issues";
import {
  fetchProviderFieldIssues,
  providerFieldIssuesFor,
  providerFieldQuestions,
} from "#src/lib/provider-field-issues";
import type { ConfigOptionsAnswer } from "#src/lib/rpc-client";
import {
  parseRpcRequestInput,
  rpcJsonResponse,
} from "#src/lib/rpc-fetch-test-support";
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
    queryClient.setQueryData<ConfigOptionsAnswer>(
      configOptionsQueryOptions({
        integrationId: "int_1",
        provider: "template-variables",
        parameters: { emailTemplateId: options.templateId ?? "tpl_1" },
      }).queryKey,
      options.answer
    );
  }

  const { result, unmount } = renderHook(
    () => useProviderFieldIssues(options.nodes, catalog),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    }
  );
  const issues = result.current;
  // These cases read one answer the cache already holds, so nothing is left to
  // wait for. Unmount before returning: a question the seed does not cover then
  // resolves against no mounted hook. Left mounted, it lands as an update after
  // the case has ended, and `isolate: false` reports that against whichever file
  // runs next.
  unmount();
  return issues;
}

describe("issues a provider-backed field raises", () => {
  it("refetches a fresh cached answer before returning blocking issues", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    const fieldsKey: readonly unknown[] = configOptionsQueryOptions({
      integrationId: "int_1",
      provider: "template-variables",
      parameters: { emailTemplateId: "tpl_1" },
    }).queryKey;
    queryClient.getQueryCache().build(queryClient, {
      queryKey: fieldsKey,
      initialData: {
        status: "fields" as const,
        fields: [],
      },
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => rpcJsonResponse(variablesAnswer));

    await expect(
      fetchProviderFieldIssues(
        queryClient,
        [node({ emailTemplateId: "tpl_1" })],
        catalog
      )
    ).resolves.toMatchObject([
      {
        fieldKey: "emailTemplateVariables.DONOR_FIRST_NAME",
        severity: "blocking",
      },
    ]);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  // One connection whose grant expired refuses every question asked of it. As a
  // rejection it took the whole preflight with it, and Run and Publish then
  // ended at a toast that no retry could clear.
  it("answers for every other question when one connection refuses", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const input = (await parseRpcRequestInput(init)) as {
          parameters?: { emailTemplateId?: string };
        };
        if (input.parameters?.emailTemplateId === "tpl_expired") {
          throw new Error("connection refused");
        }
        return rpcJsonResponse(variablesAnswer);
      }
    );
    const answering = node({ emailTemplateId: "tpl_1" });
    const refusing = {
      ...node({ emailTemplateId: "tpl_expired" }),
      id: "n2",
    } as WorkflowNode;

    const issues = await fetchProviderFieldIssues(
      queryClient,
      [answering, refusing],
      catalog
    );

    expect(issues).toMatchObject([
      {
        kind: "missing_required_field",
        nodeId: "n1",
        fieldKey: "emailTemplateVariables.DONOR_FIRST_NAME",
      },
      {
        kind: "unverified_provider_field",
        severity: "warning",
        nodeId: "n2",
        fieldKey: "emailTemplateVariables",
        fieldLabel: "Template Variables",
      },
    ]);
    // A field that went unchecked is not a field known to be wrong, so Run
    // Anyway stays on the table and Publish is not stopped by it.
    expect(
      hasBlockingWorkflowIssues(issues.filter((issue) => issue.nodeId === "n2"))
    ).toBe(false);
  });

  it("treats an explicit provider refusal as settled manual fallback", () => {
    const [question] = providerFieldQuestions(
      [node({ emailTemplateId: "tpl_1" })],
      catalog
    );
    const answer: ConfigOptionsAnswer = {
      status: "unavailable",
      reason: "not_permitted",
      message: "Enter the values manually.",
    };

    expect(providerFieldIssuesFor(question!, answer)).toEqual([]);
  });

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
      // The sub-input's own id, which is the element `useGoToStep` focuses. The
      // parent key belongs to the fallback textarea, which is not on screen once
      // the form has drawn, so naming it would focus nothing.
      fieldKey: "emailTemplateVariables.DONOR_FIRST_NAME",
      fieldLabel: "Template Variables · DONOR_FIRST_NAME",
    });
    // Blocking is what stops the publish this used to let through.
    expect(hasBlockingWorkflowIssues(issues)).toBe(true);
  });

  // Two variables under one field used to answer the same `fieldKey`, which the
  // issues list groups by node and keys its rows on, so one node missing two of
  // them drew two rows React could not tell apart.
  it("names each missing variable separately under one field", () => {
    const issues = collect({
      nodes: [node({ emailTemplateId: "tpl_1" })],
      answer: {
        status: "fields",
        fields: [
          {
            key: "DONOR_FIRST_NAME",
            label: "DONOR_FIRST_NAME",
            required: true,
          },
          { key: "CITY", label: "CITY", required: true },
        ],
      },
    });

    expect(issues.map((issue) => issue.fieldKey)).toEqual([
      "emailTemplateVariables.DONOR_FIRST_NAME",
      "emailTemplateVariables.CITY",
    ]);
  });

  // The panel stores a variable the provider declared `number` as a JSON number,
  // and Resend marks a variable required whenever it has no fallback, so the two
  // meet. Reading presence as "a non-blank string" reported a filled numeric
  // variable as missing and blocked the publish with the value on screen.
  it("counts a stored number as a value for a required numeric variable", () => {
    const issues = collect({
      nodes: [
        node({
          emailTemplateId: "tpl_1",
          emailTemplateVariables: JSON.stringify({ DONATION_AMOUNT: 250 }),
        }),
      ],
      answer: {
        status: "fields",
        fields: [
          {
            key: "DONATION_AMOUNT",
            label: "DONATION_AMOUNT",
            type: "number",
            required: true,
          },
        ],
      },
    });

    expect(issues).toEqual([]);
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
    const [question] = providerFieldQuestions(
      [node({ emailTemplateId: "tpl_1" })],
      catalog
    );
    const issues = providerFieldIssuesFor(question!, undefined);

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

afterEach(() => {
  vi.restoreAllMocks();
});
