import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { agentToolkit } from "@wfgraph/agent/toolkit";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { readJsonObject } from "@wfgraph/shared/types/json";
import { Conflict, DraftConflict } from "#src/backend/lib/effect/failures";
import type { AuthContext } from "#src/backend/lib/http/authorize";
import {
  createAgentMcpHandler,
  createAgentMcpServer,
  type CreateAgentMcpServerInput,
  type DraftToolExecution,
  type DraftToolExecutor,
  type WorkflowCreateExecutor,
  type WorkflowListExecutor,
} from "#src/backend/agent/mcp-server";

const allowAll: AuthContext = { allows: async () => true };
const listNoWorkflows: WorkflowListExecutor = async () => ({
  ok: true,
  workflows: [],
});

function createTestMcpHandler(
  input: Omit<CreateAgentMcpServerInput, "listWorkflows" | "createWorkflow">
) {
  return createAgentMcpHandler({
    ...input,
    listWorkflows: listNoWorkflows,
    createWorkflow: async () => ({
      ok: true,
      workflowId: "wf_created",
      draftRevision: 1,
    }),
  });
}

function localMcpRequest(
  input: RequestInfo | URL,
  init?: RequestInit
): Request {
  const request = new Request(input, init);
  request.headers.set("host", "localhost");
  return request;
}

async function makeSubject(input?: {
  auth?: AuthContext;
  execute?: DraftToolExecutor;
  listWorkflows?: WorkflowListExecutor;
  createWorkflow?: WorkflowCreateExecutor;
}) {
  const execute =
    input?.execute ??
    (async () => ({
      ok: true as const,
      result: {
        workflowId: "wf_1",
        draftRevision: 4,
        result: { nodes: [], edges: [], totalNodes: 0, totalEdges: 0 },
        isFailure: false,
      },
    }));
  const server = createAgentMcpServer({
    auth: input?.auth ?? allowAll,
    execute,
    listWorkflows: input?.listWorkflows ?? listNoWorkflows,
    createWorkflow:
      input?.createWorkflow ??
      (async () => ({
        ok: true as const,
        workflowId: "wf_created",
        draftRevision: 1,
      })),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "wfgraph-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } }
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server, execute };
}

describe("createAgentMcpServer", () => {
  it("exposes canonical tools with persisted-draft transport fields", async () => {
    const { client, server } = await makeSubject();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).toSorted()).toEqual(
        [
          "list_workflows",
          "create_workflow",
          // revert_draft is turn-scoped, and an MCP call carries no turn.
          ...Object.values(agentToolkit.tools)
            .map((tool) => tool.name)
            .filter((name) => name !== "revert_draft"),
        ].toSorted()
      );
      expect(
        listed.tools.find((tool) => tool.name === "list_workflows")
      ).toMatchObject({
        annotations: { readOnlyHint: true, idempotentHint: true },
        inputSchema: { type: "object", additionalProperties: false },
      });
      const read = listed.tools.find((tool) => tool.name === "read_workflow");
      const write = listed.tools.find((tool) => tool.name === "add_node");
      const create = listed.tools.find(
        (tool) => tool.name === "create_workflow"
      );

      expect(create).toMatchObject({
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
        inputSchema: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            description: { type: "string" },
          },
        },
        outputSchema: {
          type: "object",
          required: ["workflowId", "draftRevision"],
          additionalProperties: false,
        },
      });

      expect(read).toMatchObject({
        description: expect.stringContaining("workflowId"),
        inputSchema: {
          type: "object",
          required: expect.arrayContaining(["workflowId"]),
        },
        outputSchema: { type: "object" },
      });
      expect(read?.inputSchema.required).not.toContain("expectedDraftRevision");
      expect(write).toMatchObject({
        description: expect.stringContaining("expectedDraftRevision"),
        inputSchema: {
          type: "object",
          required: expect.arrayContaining([
            "workflowId",
            "expectedDraftRevision",
          ]),
        },
        outputSchema: { type: "object" },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lists workflows visible through the authenticated workflow list", async () => {
    const checked: string[] = [];
    const listWorkflows = vi.fn<WorkflowListExecutor>(async () => ({
      ok: true,
      workflows: [
        {
          id: "wf_1",
          name: "Onboard customer",
          description: "Creates the customer account",
          isPaused: false,
          mode: "live",
          visibility: "private",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-03T11:00:00.000Z",
          publishedVersionId: "version_3",
        },
      ],
    }));
    const execute = vi.fn<DraftToolExecutor>(async () => {
      throw new Error("unexpected");
    });
    const { client, server } = await makeSubject({
      auth: {
        allows: async (operation) => {
          checked.push(operation.id);
          return true;
        },
      },
      execute,
      listWorkflows,
    });
    try {
      const result = await client.callTool({
        name: "list_workflows",
        arguments: {},
      });

      expect(checked).toEqual([WfGraphOperations.workflowGetAll.id]);
      expect(listWorkflows).toHaveBeenCalledWith(expect.any(AbortSignal));
      expect(execute).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        isError: false,
        structuredContent: {
          workflows: [
            {
              id: "wf_1",
              name: "Onboard customer",
              visibility: "private",
              publishedVersionId: "version_3",
            },
          ],
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("requires workflow list access before discovering workflows", async () => {
    const listWorkflows = vi.fn<WorkflowListExecutor>(async () => {
      throw new Error("unexpected");
    });
    const { client, server } = await makeSubject({
      auth: {
        allows: async (operation) =>
          operation !== WfGraphOperations.workflowGetAll,
      },
      listWorkflows,
    });
    try {
      const result = await client.callTool({
        name: "list_workflows",
        arguments: {},
      });

      expect(listWorkflows).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { reason: "Forbidden" },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("creates a workflow through the create grant and returns its draft identity", async () => {
    const checked: string[] = [];
    const createWorkflow = vi.fn<WorkflowCreateExecutor>(async () => ({
      ok: true,
      workflowId: "wf_created",
      draftRevision: 1,
    }));
    const { client, server } = await makeSubject({
      auth: {
        allows: async (operation) => {
          checked.push(operation.id);
          return true;
        },
      },
      createWorkflow,
    });
    try {
      const result = await client.callTool({
        name: "create_workflow",
        arguments: {
          name: "  Send appointment reminders  ",
          description: "Notify patients before an appointment.",
        },
      });

      expect(checked).toEqual([WfGraphOperations.workflowCreate.id]);
      expect(createWorkflow).toHaveBeenCalledWith(
        {
          name: "  Send appointment reminders  ",
          description: "Notify patients before an appointment.",
        },
        expect.any(AbortSignal)
      );
      expect(result).toMatchObject({
        isError: false,
        structuredContent: { workflowId: "wf_created", draftRevision: 1 },
      });
      expect(result.structuredContent).toEqual({
        workflowId: "wf_created",
        draftRevision: 1,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses workflow creation before executing when the create grant is missing", async () => {
    const checked: string[] = [];
    const createWorkflow = vi.fn<WorkflowCreateExecutor>(async () => {
      throw new Error("unexpected");
    });
    const { client, server } = await makeSubject({
      auth: {
        allows: async (operation) => {
          checked.push(operation.id);
          return false;
        },
      },
      createWorkflow,
    });
    try {
      const result = await client.callTool({
        name: "create_workflow",
        arguments: { name: "Send appointment reminders" },
      });

      expect(checked).toEqual([WfGraphOperations.workflowCreate.id]);
      expect(createWorkflow).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { reason: "Forbidden" },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns workflow creation failures as tool errors", async () => {
    const { client, server } = await makeSubject({
      createWorkflow: async () => ({
        ok: false,
        failure: new Conflict({
          error: 'Workflow name "Send appointment reminders" already exists',
        }),
      }),
    });
    try {
      const result = await client.callTool({
        name: "create_workflow",
        arguments: { name: "Send appointment reminders" },
      });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          reason: 'Workflow name "Send appointment reminders" already exists',
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("strips transport fields and returns the persisted revision", async () => {
    const execute = vi.fn<DraftToolExecutor>(async () => ({
      ok: true,
      result: {
        workflowId: "wf_1",
        draftRevision: 4,
        result: { nodes: [], edges: [], totalNodes: 0, totalEdges: 0 },
        isFailure: false,
      },
    }));
    const { client, server } = await makeSubject({ execute });
    try {
      const result = await client.callTool({
        name: "read_workflow",
        arguments: { workflowId: "wf_1" },
      });

      expect(execute).toHaveBeenCalledWith(
        {
          workflowId: "wf_1",
          name: "read_workflow",
          arguments: {},
          toolCallId: expect.any(String),
        },
        expect.any(AbortSignal)
      );
      expect(result).toMatchObject({
        isError: false,
        structuredContent: {
          workflowId: "wf_1",
          draftRevision: 4,
          totalNodes: 0,
          totalEdges: 0,
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("checks write grants before executing a tool", async () => {
    const checked: string[] = [];
    const auth: AuthContext = {
      allows: async (operation) => {
        checked.push(operation.id);
        return operation !== WfGraphOperations.workflowUpdate;
      },
    };
    const execute = vi.fn<DraftToolExecutor>(async () => {
      throw new Error("unexpected");
    });
    const { client, server } = await makeSubject({ auth, execute });
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

      expect(checked).toEqual([
        WfGraphOperations.workflowGetById.id,
        WfGraphOperations.workflowUpdate.id,
      ]);
      expect(execute).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          workflowId: "wf_secret",
          reason: "Forbidden",
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("requires integration read access before listing Connection IDs", async () => {
    const checked: string[] = [];
    const auth: AuthContext = {
      allows: async (operation) => {
        checked.push(operation.id);
        return operation !== WfGraphOperations.integrationGetAll;
      },
    };
    const execute = vi.fn<DraftToolExecutor>(async () => {
      throw new Error("unexpected");
    });
    const { client, server } = await makeSubject({ auth, execute });
    try {
      const result = await client.callTool({
        name: "list_integrations",
        arguments: { workflowId: "wf_secret" },
      });

      expect(checked).toEqual([
        WfGraphOperations.workflowGetById.id,
        WfGraphOperations.integrationGetAll.id,
      ]);
      expect(execute).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("maps a stale draft to a recoverable tool result", async () => {
    const execute: DraftToolExecutor = async () => ({
      ok: false,
      failure: new DraftConflict({
        error: "The workflow draft changed. Read it again before editing.",
        currentDraftRevision: 5,
      }),
    });
    const { client, server } = await makeSubject({ execute });
    try {
      const result = await client.callTool({
        name: "add_node",
        arguments: {
          workflowId: "wf_1",
          expectedDraftRevision: 4,
          actionId: "score-applicant",
          label: "Score",
        },
      });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          workflowId: "wf_1",
          draftRevision: 5,
          code: "workflow_draft_stale",
          reason: expect.stringContaining("Read it again"),
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("createAgentMcpHandler", () => {
  it("returns malformed tool arguments as a protocol error", async () => {
    const execute = vi.fn<DraftToolExecutor>(async () => {
      throw new Error("unexpected");
    });
    const handler = createTestMcpHandler({ auth: allowAll, execute });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://localhost/mcp"),
      {
        fetch: async (input, init) =>
          await handler.fetch(localMcpRequest(input, init)),
      }
    );
    const client = new Client(
      { name: "wfgraph-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );

    await client.connect(transport);
    try {
      await expect(
        client.callTool({ name: "read_workflow", arguments: {} })
      ).rejects.toMatchObject({ code: -32602 });
      await expect(
        client.callTool({
          name: "list_workflows",
          arguments: { unexpected: true },
        })
      ).rejects.toMatchObject({ code: -32602 });
      await expect(
        client.callTool({
          name: "create_workflow",
          arguments: { name: "Reminders", graph: {} },
        })
      ).rejects.toMatchObject({ code: -32602 });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await handler.close();
    }
  });

  it("serves one modern JSON exchange without a transport session", async () => {
    const handler = createTestMcpHandler({
      auth: allowAll,
      execute: async () => ({
        ok: true,
        result: {
          workflowId: "wf_1",
          draftRevision: 4,
          result: { nodes: [], edges: [], totalNodes: 0, totalEdges: 0 },
          isFailure: false,
        },
      }),
    });
    const requests: Request[] = [];
    const responses: Response[] = [];
    const transport = new StreamableHTTPClientTransport(
      new URL("http://localhost/mcp"),
      {
        fetch: async (input, init) => {
          const request = localMcpRequest(input, init);
          requests.push(request.clone());
          const response = await handler.fetch(request);
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
      await client.callTool({
        name: "read_workflow",
        arguments: { workflowId: "wf_1" },
      });

      expect(client.getProtocolEra()).toBe("modern");
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.method).toBe("POST");
        expect(request.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
        expect(request.headers.get("Mcp-Method")).toBeTruthy();
      }
      expect(requests[1]?.headers.get("Mcp-Name")).toBe("read_workflow");
      expect(
        responses.every((response) => !response.headers.has("Mcp-Session-Id"))
      ).toBe(true);
    } finally {
      await client.close();
      await handler.close();
    }
  });

  it("rejects legacy initialization and session methods", async () => {
    const handler = createTestMcpHandler({
      auth: allowAll,
      execute: async () => {
        throw new Error("unexpected");
      },
    });
    try {
      const initialize = await handler.fetch(
        localMcpRequest("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "MCP-Protocol-Version": "2025-06-18",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "legacy", version: "1.0.0" },
            },
          }),
        })
      );
      const get = await handler.fetch(
        localMcpRequest("http://localhost/mcp", { method: "GET" })
      );
      const deleteResponse = await handler.fetch(
        localMcpRequest("http://localhost/mcp", { method: "DELETE" })
      );

      expect(initialize.status).toBe(400);
      expect(await initialize.json()).toMatchObject({
        error: { code: -32022 },
      });
      expect(get.status).toBe(405);
      expect(deleteResponse.status).toBe(405);
    } finally {
      await handler.close();
    }
  });

  it("rejects unsupported modern protocol versions", async () => {
    const handler = createTestMcpHandler({
      auth: allowAll,
      execute: async () => {
        throw new Error("unexpected");
      },
    });
    try {
      const response = await handler.fetch(
        localMcpRequest("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "MCP-Protocol-Version": "2099-01-01",
            "Mcp-Method": "server/discover",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "server/discover",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2099-01-01",
                "io.modelcontextprotocol/clientInfo": {
                  name: "wfgraph-test",
                  version: "1.0.0",
                },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        })
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: -32022,
          data: { requested: "2099-01-01", supported: ["2026-07-28"] },
        },
      });
    } finally {
      await handler.close();
    }
  });

  it("rejects JSON-RPC batches", async () => {
    const handler = createTestMcpHandler({
      auth: allowAll,
      execute: async () => {
        throw new Error("unexpected");
      },
    });
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "wfgraph-test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    };
    try {
      const response = await handler.fetch(
        localMcpRequest("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": "server/discover",
          },
          body: JSON.stringify([request, { ...request, id: 2 }]),
        })
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: -32600 },
      });
    } finally {
      await handler.close();
    }
  });

  it("rejects standard headers that disagree with the request", async () => {
    const handler = createTestMcpHandler({
      auth: allowAll,
      execute: async () => ({
        ok: true,
        result: {
          workflowId: "wf_1",
          draftRevision: 4,
          result: { nodes: [], edges: [], totalNodes: 0, totalEdges: 0 },
          isFailure: false,
        },
      }),
    });
    const callRequests: Request[] = [];
    const transport = new StreamableHTTPClientTransport(
      new URL("http://localhost/mcp"),
      {
        fetch: async (input, init) => {
          const request = localMcpRequest(input, init);
          if (request.headers.get("Mcp-Name") === "read_workflow") {
            callRequests.push(request.clone());
          }
          return await handler.fetch(request);
        },
      }
    );
    const client = new Client(
      { name: "wfgraph-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );

    await client.connect(transport);
    try {
      await client.callTool({
        name: "read_workflow",
        arguments: { workflowId: "wf_1" },
      });
      const callRequest = callRequests[0];
      if (!callRequest) {
        throw new Error("The client did not send a tools/call request");
      }
      const headers = new Headers(callRequest.headers);
      headers.set("Mcp-Method", "tools/list");
      const response = await handler.fetch(
        localMcpRequest("http://localhost/mcp", {
          method: "POST",
          headers,
          body: await callRequest.text(),
        })
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: -32020 },
      });
    } finally {
      await client.close();
      await handler.close();
    }
  });

  it("requires client identity and capabilities in every request envelope", async () => {
    const handler = createTestMcpHandler({
      auth: allowAll,
      execute: async () => {
        throw new Error("unexpected");
      },
    });
    const discoverRequests: Request[] = [];
    const transport = new StreamableHTTPClientTransport(
      new URL("http://localhost/mcp"),
      {
        fetch: async (input, init) => {
          const request = localMcpRequest(input, init);
          discoverRequests.push(request.clone());
          return await handler.fetch(request);
        },
      }
    );
    const client = new Client(
      { name: "wfgraph-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );

    await client.connect(transport);
    try {
      const discoverRequest = discoverRequests[0];
      if (!discoverRequest) {
        throw new Error("The client did not send a discovery request");
      }
      const body = readJsonObject(await discoverRequest.json());
      const params = readJsonObject(body?.params);
      const meta = readJsonObject(params?.["_meta"]);
      if (!body || !params || !meta) {
        throw new Error("The client sent an invalid discovery request");
      }
      const clientInfo = meta["io.modelcontextprotocol/clientInfo"];
      delete meta["io.modelcontextprotocol/clientInfo"];
      params["_meta"] = meta;
      body.params = params;
      const missingIdentity = await handler.fetch(
        localMcpRequest("http://localhost/mcp", {
          method: "POST",
          headers: discoverRequest.headers,
          body: JSON.stringify(body),
        })
      );
      if (clientInfo === undefined) {
        throw new Error("The client omitted its identity");
      }
      meta["io.modelcontextprotocol/clientInfo"] = clientInfo;
      delete meta["io.modelcontextprotocol/clientCapabilities"];
      const missingCapabilities = await handler.fetch(
        localMcpRequest("http://localhost/mcp", {
          method: "POST",
          headers: discoverRequest.headers,
          body: JSON.stringify(body),
        })
      );

      expect(missingIdentity.status).toBe(400);
      expect(await missingIdentity.json()).toMatchObject({
        error: { code: -32602 },
      });
      expect(missingCapabilities.status).toBe(400);
      expect(await missingCapabilities.json()).toMatchObject({
        error: { code: -32602 },
      });
    } finally {
      await client.close();
      await handler.close();
    }
  });

  it("passes HTTP request cancellation to tool execution", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let executionWasAborted = false;
    const handler = createTestMcpHandler({
      auth: allowAll,
      execute: async (_input, signal) => {
        markStarted?.();
        return await new Promise<DraftToolExecution>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              executionWasAborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true }
          );
        });
      },
    });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://localhost/mcp"),
      {
        fetch: async (input, init) =>
          await handler.fetch(localMcpRequest(input, init)),
      }
    );
    const client = new Client(
      { name: "wfgraph-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );

    await client.connect(transport);
    try {
      const abort = new AbortController();
      const call = client.callTool(
        {
          name: "read_workflow",
          arguments: { workflowId: "wf_1" },
        },
        { signal: abort.signal }
      );
      await started;
      abort.abort();

      await expect(call).rejects.toThrow();
      expect(executionWasAborted).toBe(true);
    } finally {
      await client.close();
      await handler.close();
    }
  });
});
