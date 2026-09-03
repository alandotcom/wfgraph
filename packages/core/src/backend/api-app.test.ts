import { afterAll, describe, expect, it } from "vitest";
import { resetSync } from "@logtape/logtape";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { fixtureCatalog } from "@wfgraph/agent/tools/catalog-fixture";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { Workflow } from "#src/backend/lib/db/schema";
import { createApiApp } from "#src/backend/api-app";
import {
  defineWfGraphAuth,
  resolveAuth,
  trustWfGraphUpstream,
  WfGraphAccess,
} from "#src/backend/lib/http/authorize";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import { configureLoggingWithBridge } from "#src/backend/lib/log-config";
import { MAX_REQUEST_BODY_BYTES } from "#src/backend/lib/http/capped-body";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

const basePath = "/wfgraph/api" as const;

const workflow: Workflow = {
  id: "wf_1",
  name: "Workflow",
  description: null,
  graph: createSerializedWorkflowGraph({
    nodes: [
      {
        id: "entry",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: { type: "lifecycle", label: "Lifecycle", config: {} },
      },
    ],
    edges: [],
  }),
  draftRevision: 3,
  isPaused: false,
  mode: "live",
  visibility: "private",
  publishedVersionId: null,
  createdAt: new Date("2026-09-03T00:00:00.000Z"),
  updatedAt: new Date("2026-09-03T00:00:00.000Z"),
};

/** Captures the structured fields of every record the request middleware wrote. */
function captureRequestFields(): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const take = (properties: unknown) => {
    if (typeof properties === "object" && properties !== null) {
      records.push(properties as Record<string, unknown>);
    }
  };
  configureLoggingWithBridge(
    {
      debug: (_message, properties) => take(properties),
      info: (_message, properties) => take(properties),
      warn: (_message, properties) => take(properties),
      error: (_message, properties) => take(properties),
    },
    "debug"
  );
  return records;
}

describe("the request log record", () => {
  it("leaves the rpc group out of a request that addressed no procedure", async () => {
    const records = captureRequestFields();
    await using runtime = stubWfGraphRuntime({});
    const app = createApiApp({
      basePath,
      auth: resolveAuth(trustWfGraphUpstream()),
      runtime,
    });

    await app.fetch(new Request(`http://localhost${basePath}/nothing-here`));

    // The pretty formatter prints a line per top-level field, so an `rpc` key
    // holding `undefined` reaches the reader as a bare `rpc: undefined` line.
    const request = records.find((fields) => fields["http"] !== undefined);
    expect(request).toBeDefined();
    expect(request && "rpc" in request).toBe(false);
  });
});

describe("the MCP route", () => {
  it("is absent until the host opts in", async () => {
    await using runtime = stubWfGraphRuntime({});
    const app = createApiApp({
      basePath,
      auth: resolveAuth(trustWfGraphUpstream()),
      runtime,
    });

    const response = await app.fetch(
      new Request(`http://localhost${basePath}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    );

    expect(response.status).toBe(404);
  });

  it("serves modern stateless tool calls when the host opts in", async () => {
    const records = captureRequestFields();
    const {
      graph: _graph,
      draftRevision: _draftRevision,
      ...workflowSummary
    } = workflow;
    await using runtime = stubWfGraphRuntime({
      extensions: { catalog: fixtureCatalog },
      integrationRepo: { listIdentities: Effect.succeed([]) },
      workflowRepo: {
        findById: () => Effect.succeed(workflow),
        listSummariesNewestFirst: Effect.succeed([workflowSummary]),
      },
    });
    const app = createApiApp({
      basePath,
      auth: resolveAuth(trustWfGraphUpstream()),
      runtime,
      mcp: true,
    });
    const requests: Request[] = [];
    const responses: Response[] = [];
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost${basePath}/mcp`),
      {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          request.headers.set("host", "localhost");
          requests.push(request.clone());
          const response = await app.fetch(request);
          responses.push(response.clone());
          return response;
        },
      }
    );
    const client = new Client(
      { name: "wfgraph-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );

    await client.connect(transport);
    try {
      const listed = await client.callTool({
        name: "list_workflows",
        arguments: {},
      });
      const result = await client.callTool({
        name: "read_workflow",
        arguments: { workflowId: workflow.id },
      });

      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getServerVersion()).toEqual({
        name: "workflow-graph",
        version: "1.0.0",
      });
      expect(listed).toMatchObject({
        isError: false,
        structuredContent: {
          workflows: [
            {
              id: workflow.id,
              name: workflow.name,
              visibility: workflow.visibility,
            },
          ],
        },
      });
      expect(result).toMatchObject({
        isError: false,
        structuredContent: {
          workflowId: workflow.id,
          draftRevision: 3,
          totalNodes: 1,
        },
      });
      expect(requests.every((request) => request.method === "POST")).toBe(true);
      expect(
        responses.every((response) => !response.headers.has("Mcp-Session-Id"))
      ).toBe(true);
      const callRecord = records.find(
        (fields) =>
          (fields["mcp"] as { name?: string } | undefined)?.name ===
          "read_workflow"
      );
      expect(callRecord?.mcp).toEqual({
        method: "tools/call",
        name: "read_workflow",
        workflowId: workflow.id,
        result: "success",
        draftRevision: 3,
      });
      expect(JSON.stringify(callRecord)).not.toContain('"arguments"');
      expect(JSON.stringify(callRecord)).not.toContain('"nodes"');
    } finally {
      await client.close();
    }
  });

  it("authenticates before the MCP handler reads a request", async () => {
    await using runtime = stubWfGraphRuntime({});
    const app = createApiApp({
      basePath,
      auth: resolveAuth(defineWfGraphAuth(() => null)),
      runtime,
      mcp: true,
    });

    const response = await app.fetch(
      new Request(`http://localhost${basePath}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not JSON",
      })
    );

    expect(response.status).toBe(401);
  });

  it("rejects untrusted MCP hosts and browser origins before parsing", async () => {
    await using runtime = stubWfGraphRuntime({});
    const app = createApiApp({
      basePath,
      auth: resolveAuth(trustWfGraphUpstream()),
      runtime,
      mcp: {
        allowedHostnames: ["api.example.com"],
        allowedOriginHostnames: ["console.example.com"],
      },
    });

    const [hostResponse, originResponse] = await Promise.all([
      app.fetch(
        new Request(`https://attacker.example${basePath}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: "attacker.example",
          },
          body: "not JSON",
        })
      ),
      app.fetch(
        new Request(`https://api.example.com${basePath}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: "api.example.com",
            origin: "https://attacker.example",
          },
          body: "not JSON",
        })
      ),
    ]);

    expect(hostResponse.status).toBe(403);
    expect(originResponse.status).toBe(403);
  });

  it("refuses a write before reading a workflow when its grant is missing", async () => {
    await using runtime = stubWfGraphRuntime({
      extensions: { catalog: fixtureCatalog },
    });
    const app = createApiApp({
      basePath,
      auth: resolveAuth(
        defineWfGraphAuth(() =>
          WfGraphAccess.fromOperationIds([WfGraphOperations.workflowGetById.id])
        )
      ),
      runtime,
      mcp: true,
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost${basePath}/mcp`),
      {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          request.headers.set("host", "localhost");
          return await app.fetch(request);
        },
      }
    );
    const client = new Client(
      { name: "wfgraph-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );

    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: "add_node",
        arguments: {
          workflowId: "wf_secret",
          expectedDraftRevision: 1,
          actionId: "score-applicant",
          label: "Score",
        },
      });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: { reason: "Forbidden" },
      });
    } finally {
      await client.close();
    }
  });

  it("applies the shared request body cap before MCP parsing", async () => {
    await using runtime = stubWfGraphRuntime({});
    const app = createApiApp({
      basePath,
      auth: resolveAuth(trustWfGraphUpstream()),
      runtime,
      mcp: true,
    });

    const response = await app.fetch(
      new Request(`http://localhost${basePath}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
          host: "localhost",
        },
        body: "{}",
      })
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Request body is too large",
    });
  });
});

// Back to unconfigured, which is logtape's own default and what every other
// file in this worker expects: the suite shares one module graph.
afterAll(() => {
  resetSync();
});
