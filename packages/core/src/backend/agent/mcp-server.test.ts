import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { fixtureCatalog } from "@wfgraph/agent/tools/catalog-fixture";
import { makeAgentToolSession } from "#src/backend/agent/tool-session";
import { createAgentMcpServer } from "#src/backend/agent/mcp-server";
import type { AgentStreamPart } from "@wfgraph/shared/rpc/agent-stream";
import type { AgentTraceEvent } from "#src/backend/agent/trace";

async function makeSubject() {
  const trace: AgentTraceEvent[] = [];
  const parts: AgentStreamPart[] = [];
  const session = await Effect.runPromise(
    makeAgentToolSession({
      document: {
        nodes: [
          {
            id: "entry",
            type: "lifecycle",
            position: { x: 0, y: 0 },
            data: {
              type: "lifecycle",
              label: "Lifecycle",
              config: {},
            },
          },
        ],
        edges: [],
      },
      catalog: fixtureCatalog,
      integrations: [],
      validateDraft: () => ({
        draftValid: true,
        structuralIssues: [],
        publishBlockers: [],
        warnings: [],
      }),
    })
  );
  const server = createAgentMcpServer({
    session,
    observeTrace: (event) => {
      trace.push(event);
    },
    emitPart: (part) => {
      parts.push(part);
    },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "wfgraph-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } }
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server, session, trace, parts };
}

describe("createAgentMcpServer", () => {
  it("exposes the Workflow Graph tools with their schemas and results", async () => {
    const { client, server } = await makeSubject();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain("list_actions");
      expect(
        listed.tools.find((tool) => tool.name === "list_actions")
      ).toMatchObject({
        description: expect.stringContaining("Search the action catalog"),
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      });

      const result = await client.callTool({
        name: "list_actions",
        arguments: { query: "slack" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        actions: [{ id: "slack/send-message" }],
        totalMatches: 1,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns tool refusals without changing the draft revision", async () => {
    const { client, server, session, trace, parts } = await makeSubject();
    try {
      const before = await Effect.runPromise(session.draft.current);
      const result = await client.callTool({
        name: "add_node",
        arguments: { actionId: "missing/action", label: "Missing" },
      });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          reason: expect.stringContaining("missing/action"),
        },
      });
      expect(await Effect.runPromise(session.draft.current)).toEqual(before);
      expect(trace).toEqual([
        expect.objectContaining({ type: "tool-call", name: "add_node" }),
        expect.objectContaining({
          type: "tool-result",
          name: "add_node",
          failed: true,
          graphRevision: undefined,
        }),
      ]);
      expect(parts).toEqual([
        expect.objectContaining({ type: "tool-call", name: "add_node" }),
        expect.objectContaining({
          type: "tool-result",
          name: "add_node",
          failed: true,
        }),
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("emits one linked graph revision after a successful write", async () => {
    const { client, server, trace, parts } = await makeSubject();
    try {
      const result = await client.callTool({
        name: "add_node",
        arguments: { actionId: "score-applicant", label: "Score" },
      });

      expect(result.isError).not.toBe(true);
      const toolResult = trace.find((event) => event.type === "tool-result");
      const revision = trace.find((event) => event.type === "graph-revision");
      expect(toolResult).toMatchObject({
        type: "tool-result",
        failed: false,
        graphRevision: 1,
      });
      expect(revision).toMatchObject({
        type: "graph-revision",
        revision: 1,
      });
      expect(parts.map((part) => part.type)).toEqual([
        "tool-call",
        "tool-result",
        "graph",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
