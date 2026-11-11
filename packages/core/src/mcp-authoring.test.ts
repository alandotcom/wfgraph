/**
 * Drives the MCP endpoint of a real app, on SQLite in memory, through the
 * official SDK client: the same path an external client takes, with no stub
 * between the protocol and the stored draft.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { readJsonObject } from "@wfgraph/shared/types/json";
import { createWfGraphApp, type WfGraphApp } from "#src/app";
import { trustWfGraphUpstream } from "#src/backend/lib/http/authorize";
import { wfSqlite } from "#src/backend/persistence/sqlite";

/** The structured result of one tool call, failing the case when absent. */
async function call(
  client: Client,
  name: string,
  arguments_: Record<string, unknown>
) {
  const result = await client.callTool({ name, arguments: arguments_ });
  const content = readJsonObject(result.structuredContent);
  if (content === null) {
    throw new Error(`${name} answered no structured content`);
  }
  return { isError: result.isError === true, content };
}

describe("MCP authoring against a stored draft", () => {
  let app: WfGraphApp;
  let client: Client;

  beforeEach(async () => {
    app = await createWfGraphApp({
      auth: trustWfGraphUpstream(),
      persistence: wfSqlite(),
      mcp: true,
    });
    client = new Client(
      { name: "wfgraph-e2e", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
        // A server-side Request carries no Host header until one is set, and
        // the endpoint refuses a request whose Host it does not accept.
        fetch: async (input, init) => {
          const request = new Request(input, init);
          request.headers.set("host", "localhost");
          return app.fetch(request);
        },
      })
    );
  });

  afterEach(async () => {
    await client.close();
    await app.dispose();
  });

  it("builds a workflow, is refused a stale write, and recovers from a read", async () => {
    const created = await call(client, "create_workflow", {
      name: "Manual check",
    });
    const workflowId = created.content.workflowId;
    expect(typeof workflowId).toBe("string");

    const lifecycle = await call(client, "set_lifecycle_rules", {
      workflowId,
      expectedDraftRevision: created.content.draftRevision,
      allowManualStart: true,
    });
    expect(lifecycle.isError).toBe(false);
    const afterLifecycle = lifecycle.content.draftRevision;

    const read = await call(client, "read_workflow", { workflowId });
    const nodes = Array.isArray(read.content.nodes) ? read.content.nodes : [];
    const entry = readJsonObject(nodes[0])?.id;

    const added = await call(client, "add_node", {
      workflowId,
      expectedDraftRevision: afterLifecycle,
      actionId: "Condition",
      label: "Check",
      sourceNodeId: entry,
      sourceHandle: "started",
    });
    expect(added.isError).toBe(false);

    // A second write sent with the revision from before add_node is stale.
    const stale = await call(client, "add_node", {
      workflowId,
      expectedDraftRevision: afterLifecycle,
      actionId: "Wait",
      label: "Pause",
    });
    expect(stale.isError).toBe(true);
    expect(stale.content).toMatchObject({
      code: "workflow_draft_stale",
      draftRevision: added.content.draftRevision,
    });

    const reread = await call(client, "read_workflow", { workflowId });
    const retried = await call(client, "add_node", {
      workflowId,
      expectedDraftRevision: reread.content.draftRevision,
      actionId: "Wait",
      label: "Pause",
    });
    expect(retried.isError).toBe(false);

    const final = await call(client, "read_workflow", { workflowId });
    expect(final.content.totalNodes).toBe(3);

    const runs = await call(client, "list_runs", { workflowId });
    expect(runs.content).toMatchObject({ runs: [], total: 0 });
  });
});
