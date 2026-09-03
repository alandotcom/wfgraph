/**
 * Adapts one request-scoped workflow tool session to an MCP server.
 *
 * The adapter preserves the Effect tool schemas and refusal values. Successful
 * writes publish the same graph revision that the built-in runner emits.
 */

import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { Effect, Option, Stream } from "effect";
import { Tool } from "effect/unstable/ai";
import { agentToolkit, WRITE_TOOL_NAMES } from "@wfgraph/agent/toolkit";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { AgentStreamPart } from "@wfgraph/shared/rpc/agent-stream";
import { readJsonObject } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import type { AgentToolSession } from "#src/backend/agent/tool-session";
import { summarizeToolResult } from "#src/backend/agent/stream";
import type {
  AgentTraceEvent,
  AgentTraceObserver,
} from "#src/backend/agent/trace";

export type CreateAgentMcpServerInput = {
  readonly session: AgentToolSession;
  readonly observeTrace: AgentTraceObserver;
  readonly emitPart: (part: AgentStreamPart) => void | Promise<void>;
  readonly step?: number | undefined;
};

type AgentToolName = keyof typeof agentToolkit.tools;

function toolCallId(id: string | number): string {
  return String(id);
}

function executeTool(input: {
  readonly session: AgentToolSession;
  readonly name: AgentToolName;
  readonly arguments: Record<string, unknown>;
  readonly id: string;
}) {
  return input.session.toolkit
    .handle(input.name, input.arguments, input.id)
    .pipe(
      Effect.flatMap(Stream.runLast),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die("The tool handler returned no result"),
          onSome: Effect.succeed,
        })
      )
    );
}

/** Creates an MCP server bound to one mutable editor draft. */
export function createAgentMcpServer(
  input: CreateAgentMcpServerInput
): McpServer {
  const server = new McpServer({
    name: "workflow-graph",
    version: "1.0.0",
  });
  const step = input.step ?? 1;

  for (const tool of Object.values(agentToolkit.tools)) {
    const name = tool.name;
    const inputSchema = fromJsonSchema<Record<string, unknown>>(
      Tool.getJsonSchema(tool)
    );
    const outputSchema = fromJsonSchema<Record<string, unknown>>(
      Tool.getJsonSchemaFromSchema(tool.successSchema)
    );
    server.registerTool<typeof outputSchema, typeof inputSchema>(
      name,
      omitUndefined({
        description: tool.description,
        inputSchema,
        outputSchema,
      }),
      async (arguments_, context) => {
        const id = toolCallId(context.mcpReq.id);
        const argumentsObject = readJsonObject(arguments_) ?? {};
        const callEvent: AgentTraceEvent = {
          type: "tool-call",
          step,
          id,
          name,
          input: argumentsObject,
        };
        input.observeTrace(callEvent);
        await input.emitPart({
          type: "tool-call",
          id,
          name,
          input: argumentsObject,
        });

        const result = await Effect.runPromise(
          executeTool({
            session: input.session,
            name,
            arguments: arguments_,
            id,
          }),
          { signal: context.mcpReq.signal }
        );
        const resultObject = readJsonObject(result.encodedResult);
        if (!resultObject) {
          throw new Error("The tool returned a non-object result");
        }

        const graphRevision =
          !result.isFailure && WRITE_TOOL_NAMES.has(name)
            ? await Effect.runPromise(input.session.recordGraphRevision(), {
                signal: context.mcpReq.signal,
              })
            : undefined;
        input.observeTrace({
          type: "tool-result",
          step,
          id,
          name,
          result: resultObject,
          failed: result.isFailure,
          graphRevision: graphRevision?.revision,
        });
        await input.emitPart({
          type: "tool-result",
          id,
          name,
          summary: summarizeToolResult({
            name,
            result: resultObject,
            isFailure: result.isFailure,
          }),
          failed: result.isFailure,
        });

        if (graphRevision) {
          input.observeTrace({
            type: "graph-revision",
            step,
            toolCallId: id,
            revision: graphRevision.revision,
            document: graphRevision.document,
          });
          await input.emitPart({
            type: "graph",
            graph: createSerializedWorkflowGraph({
              nodes: [...graphRevision.document.nodes],
              edges: [...graphRevision.document.edges],
            }),
          });
        }

        return {
          content: [{ type: "text", text: JSON.stringify(resultObject) }],
          structuredContent: resultObject,
          isError: result.isFailure,
        };
      }
    );
  }

  return server;
}
