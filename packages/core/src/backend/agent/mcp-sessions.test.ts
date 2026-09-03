import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { fixtureCatalog } from "@wfgraph/agent/tools/catalog-fixture";
import { makeAgentToolSession } from "#src/backend/agent/tool-session";
import { createAgentMcpSessionRegistry } from "#src/backend/agent/mcp-sessions";

async function makeToolSession() {
  return await Effect.runPromise(
    makeAgentToolSession({
      document: { nodes: [], edges: [] },
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
}

describe("createAgentMcpSessionRegistry", () => {
  it("serves one authorized short-lived tool session", async () => {
    const registry = createAgentMcpSessionRegistry({
      url: "https://app.example.test/api/agent/mcp",
    });
    const connection = await registry.open({
      workflowId: "workflow-1",
      authorization: { allows: async () => true },
      session: await makeToolSession(),
      observeTrace: () => undefined,
      emitPart: () => undefined,
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(connection.url),
      {
        requestInit: { headers: connection.headers },
        fetch: async (url, init) =>
          await registry.fetch(new Request(url, init)),
      }
    );
    const client = new Client(
      { name: "wfgraph-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );

    try {
      await client.connect(transport);
      await expect(client.listTools()).resolves.toMatchObject({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "read_workflow" }),
        ]),
      });
    } finally {
      await client.close();
      await connection.close();
      await registry.close();
    }
  });

  it("rejects missing, expired, and unauthorized session credentials", async () => {
    const registry = createAgentMcpSessionRegistry({
      url: "https://app.example.test/api/agent/mcp",
    });
    const noCredential = await registry.fetch(
      new Request("https://app.example.test/api/agent/mcp", { method: "POST" })
    );
    expect(noCredential.status).toBe(401);

    await expect(
      registry.open({
        workflowId: "workflow-1",
        authorization: { allows: async () => false },
        session: await makeToolSession(),
        observeTrace: () => undefined,
        emitPart: () => undefined,
      })
    ).rejects.toThrow("authorized");

    const connection = await registry.open({
      workflowId: "workflow-1",
      authorization: { allows: async () => true },
      session: await makeToolSession(),
      observeTrace: () => undefined,
      emitPart: () => undefined,
    });
    await connection.close();
    const expired = await registry.fetch(
      new Request(connection.url, {
        method: "POST",
        headers: connection.headers,
      })
    );
    expect(expired.status).toBe(401);
    await registry.close();
  });

  it("rejects an MCP body over the request limit", async () => {
    const registry = createAgentMcpSessionRegistry({
      url: "https://app.example.test/api/agent/mcp",
      requestBodyLimit: 10,
    });
    const connection = await registry.open({
      workflowId: "workflow-1",
      authorization: { allows: async () => true },
      session: await makeToolSession(),
      observeTrace: () => undefined,
      emitPart: () => undefined,
    });

    try {
      const response = await registry.fetch(
        new Request(connection.url, {
          method: "POST",
          headers: connection.headers,
          body: JSON.stringify({ value: "too large" }),
        })
      );
      expect(response.status).toBe(413);
    } finally {
      await connection.close();
      await registry.close();
    }
  });
});
