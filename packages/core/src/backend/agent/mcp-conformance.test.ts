import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { Effect, Option, Stream } from "effect";
import { fixtureCatalog } from "@wfgraph/agent/tools/catalog-fixture";
import { agentToolkit, WRITE_TOOL_NAMES } from "@wfgraph/agent/toolkit";
import type { AgentDocument } from "@wfgraph/agent/document";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { layoutWorkflowNodes } from "@wfgraph/shared/graph/workflow-layout";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { readJsonObject } from "@wfgraph/shared/types/json";
import { makeAgentToolSession } from "#src/backend/agent/tool-session";
import {
  createAgentMcpServer,
  type DraftToolExecutor,
} from "#src/backend/agent/mcp-server";
import type { AgentToolName } from "#src/backend/services/agent/draft-tool";

const workflowId = "wf_conformance";
const draftRevision = 1;
const integrations = [{ id: "slack-primary", type: "slack" }] as const;
const validDraft = {
  draftValid: true,
  structuralIssues: [],
  publishBlockers: [],
  warnings: [],
} as const;

const nodes: readonly WorkflowNode[] = [
  {
    id: "entry",
    position: { x: 0, y: 0 },
    type: "lifecycle",
    data: {
      label: "Lifecycle",
      type: "lifecycle",
      config: {
        lifecycleRules: {
          startEvents: ["applicant.created"],
          cancelEvents: [],
          concurrency: "unlimited",
          allowManualStart: false,
        },
      },
    },
  },
  {
    id: "score",
    position: { x: 0, y: 160 },
    type: "action",
    data: {
      label: "Score applicant",
      type: "action",
      config: { actionType: "score-applicant" },
    },
  },
  {
    id: "condition",
    position: { x: 0, y: 320 },
    type: "action",
    data: {
      label: "Score is high",
      type: "action",
      config: { actionType: "Condition" },
    },
  },
  {
    id: "wait",
    position: { x: 0, y: 480 },
    type: "action",
    data: {
      label: "Wait",
      type: "action",
      config: { actionType: "Wait" },
    },
  },
  {
    id: "notify",
    position: { x: 0, y: 640 },
    type: "action",
    data: {
      label: "Notify",
      type: "action",
      config: {
        actionType: "slack/send-message",
        integrationId: "slack-primary",
      },
    },
  },
];

const edges: readonly WorkflowEdge[] = [
  {
    id: "entry-score",
    source: "entry",
    target: "score",
    sourceHandle: "started",
  },
  { id: "score-condition", source: "score", target: "condition" },
  {
    id: "condition-wait",
    source: "condition",
    target: "wait",
    sourceHandle: "true",
  },
  { id: "wait-notify", source: "wait", target: "notify" },
];

type ConformanceCase = {
  readonly name: AgentToolName;
  readonly arguments: JsonObject;
  readonly document?: AgentDocument | undefined;
};

const successCases: readonly ConformanceCase[] = [
  { name: "list_actions", arguments: {} },
  { name: "describe_action", arguments: { actionId: "score-applicant" } },
  { name: "describe_event", arguments: { eventName: "applicant.created" } },
  { name: "list_events", arguments: {} },
  { name: "list_integrations", arguments: {} },
  { name: "read_workflow", arguments: {} },
  { name: "read_nodes", arguments: { nodeIds: ["score"] } },
  { name: "validate_workflow", arguments: {} },
  { name: "list_references", arguments: { nodeId: "notify" } },
  {
    name: "add_node",
    arguments: { actionId: "score-applicant", label: "Added score" },
  },
  { name: "update_node", arguments: { nodeId: "score", label: "Rescore" } },
  { name: "delete_node", arguments: { nodeId: "notify" } },
  {
    name: "connect_nodes",
    arguments: { source: "wait", target: "notify" },
    document: {
      nodes,
      edges: edges.filter((edge) => edge.id !== "wait-notify"),
    },
  },
  { name: "disconnect_nodes", arguments: { edgeId: "wait-notify" } },
  {
    name: "insert_node_on_edge",
    arguments: {
      edgeId: "score-condition",
      actionId: "score-applicant",
      label: "Review score",
    },
  },
  {
    name: "set_lifecycle_rules",
    arguments: { concurrency: "first-wins" },
  },
  {
    name: "set_condition",
    arguments: {
      nodeId: "condition",
      groups: [
        {
          rules: [
            {
              field: "score",
              fieldType: "number",
              operator: "greater_or_equal",
              value: "70",
            },
          ],
        },
      ],
    },
  },
  {
    name: "set_wait",
    arguments: { nodeId: "wait", wait: { mode: "duration", duration: "2d" } },
  },
];

const refusalCases: readonly ConformanceCase[] = [
  { name: "describe_action", arguments: { actionId: "missing/action" } },
  { name: "describe_event", arguments: { eventName: "missing.event" } },
  { name: "read_nodes", arguments: { nodeIds: ["missing"] } },
  { name: "list_references", arguments: { nodeId: "missing" } },
  {
    name: "add_node",
    arguments: { actionId: "missing/action", label: "Missing" },
  },
  { name: "update_node", arguments: { nodeId: "missing", label: "Missing" } },
  { name: "delete_node", arguments: { nodeId: "missing" } },
  { name: "connect_nodes", arguments: { source: "missing", target: "score" } },
  { name: "disconnect_nodes", arguments: { edgeId: "missing" } },
  {
    name: "insert_node_on_edge",
    arguments: {
      edgeId: "missing",
      actionId: "score-applicant",
      label: "Missing",
    },
  },
  {
    name: "set_lifecycle_rules",
    arguments: { startEvents: ["missing.event"] },
  },
  {
    name: "set_condition",
    arguments: { nodeId: "missing", groups: [] },
  },
  {
    name: "set_wait",
    arguments: {
      nodeId: "missing",
      wait: { mode: "duration", duration: "2d" },
    },
  },
];

function documentFor(testCase: ConformanceCase): AgentDocument {
  return testCase.document ?? { nodes, edges };
}

async function runCanonicalTool(testCase: ConformanceCase) {
  const initial = documentFor(testCase);
  const session = await Effect.runPromise(
    makeAgentToolSession({
      document: initial,
      catalog: fixtureCatalog,
      integrations,
      validateDraft: () => validDraft,
    })
  );
  const handled = await Effect.runPromise(
    session.toolkit
      .handle(testCase.name, testCase.arguments, "call_direct")
      .pipe(Effect.flatMap(Stream.runLast))
  );
  const toolResult = Option.getOrThrow(handled);
  const result = readJsonObject(toolResult.encodedResult);
  if (!result) {
    throw new Error(`${testCase.name} returned a non-object result`);
  }
  const current = await Effect.runPromise(session.draft.current);
  const laidOut =
    WRITE_TOOL_NAMES.has(testCase.name) && !toolResult.isFailure
      ? layoutWorkflowNodes({
          nodes: [...current.nodes],
          edges: [...current.edges],
          catalog: fixtureCatalog,
        })
      : undefined;
  const graph = laidOut
    ? { nodes: laidOut.nodes, edges: current.edges }
    : current;

  return { result, isFailure: toolResult.isFailure, graph };
}

async function runMcpTool(testCase: ConformanceCase) {
  let graph: AgentDocument = documentFor(testCase);
  const execute: DraftToolExecutor = async (input) => {
    const result = await runCanonicalTool({
      name: input.name,
      arguments: input.arguments,
      document: graph,
    });
    graph = result.graph;
    return {
      ok: true,
      result: {
        workflowId,
        draftRevision:
          WRITE_TOOL_NAMES.has(input.name) && !result.isFailure ? 2 : 1,
        result: result.result,
        isFailure: result.isFailure,
      },
    };
  };
  const server = createAgentMcpServer({
    auth: { allows: async () => true },
    execute,
    listWorkflows: async () => ({ ok: true, workflows: [] }),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "wfgraph-conformance", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } }
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.callTool({
      name: testCase.name,
      arguments: {
        ...testCase.arguments,
        workflowId,
        ...(WRITE_TOOL_NAMES.has(testCase.name)
          ? { expectedDraftRevision: draftRevision }
          : {}),
      },
    });
    const structured = readJsonObject(result.structuredContent);
    if (!structured) {
      throw new Error(`${testCase.name} returned no structured content`);
    }
    const {
      workflowId: returnedWorkflowId,
      draftRevision: returnedDraftRevision,
      ...canonicalResult
    } = structured;
    expect(returnedWorkflowId).toBe(workflowId);
    expect(returnedDraftRevision).toBe(
      WRITE_TOOL_NAMES.has(testCase.name) && !result.isError ? 2 : 1
    );
    return {
      result: canonicalResult,
      isFailure: result.isError === true,
      graph,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

function normalizeGeneratedIds(value: unknown): unknown {
  const replacements = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(value, (_key, candidate: unknown) => {
      if (typeof candidate !== "string") {
        return candidate;
      }
      return candidate.replace(/[A-Za-z0-9_-]{21}/gu, (id) => {
        const existing = replacements.get(id);
        if (existing) {
          return existing;
        }
        const replacement = `<generated-${replacements.size + 1}>`;
        replacements.set(id, replacement);
        return replacement;
      });
    })
  ) as unknown;
}

describe("native and MCP tool conformance", () => {
  it("covers every canonical tool with a successful fixture", () => {
    expect(successCases.map(({ name }) => name).toSorted()).toEqual(
      Object.values(agentToolkit.tools)
        .map((tool) => tool.name)
        .toSorted()
    );
  });

  for (const testCase of successCases) {
    it(`returns the same successful result and graph for ${testCase.name}`, async () => {
      const direct = await runCanonicalTool(testCase);
      const mcp = await runMcpTool(testCase);

      expect(mcp.isFailure).toBe(false);
      expect(normalizeGeneratedIds(mcp.result)).toEqual(
        normalizeGeneratedIds(direct.result)
      );
      expect(normalizeGeneratedIds(mcp.graph)).toEqual(
        normalizeGeneratedIds(direct.graph)
      );
    });
  }

  for (const testCase of refusalCases) {
    it(`returns the same refusal without changing the graph for ${testCase.name}`, async () => {
      const initial = documentFor(testCase);
      const direct = await runCanonicalTool(testCase);
      const mcp = await runMcpTool(testCase);

      expect(mcp.isFailure).toBe(true);
      expect(mcp.result).toEqual(direct.result);
      expect(mcp.graph).toEqual(initial);
      expect(direct.graph).toEqual(initial);
    });
  }
});
