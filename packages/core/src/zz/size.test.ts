import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { it } from "vitest";
import { createAgentMcpServer } from "#src/backend/agent/mcp-server";
it("size", async () => {
  const server = createAgentMcpServer({ auth: { allows: async () => true }, execute: async () => { throw new Error(); }, listWorkflows: async () => { throw new Error(); }, createWorkflow: async () => { throw new Error(); } });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "x", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(s); await client.connect(c);
  const { tools } = await client.listTools();
  const sizes = tools.map((t) => `${t.name} ${JSON.stringify(t).length} in=${JSON.stringify(t.inputSchema).length} out=${JSON.stringify(t.outputSchema ?? {}).length} desc=${(t.description??"").length}`);
  throw new Error(`TOTAL ${JSON.stringify(tools).length}\n${sizes.join("\n")}\nINSTR ${client.getInstructions()?.length}`);
});
