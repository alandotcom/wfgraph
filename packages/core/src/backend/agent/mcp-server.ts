/** Adapts the canonical authoring toolkit to persisted, stateless MCP calls. */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  hostHeaderValidationResponse,
  INVALID_PARAMS,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  McpServer,
  originValidationResponse,
  PROTOCOL_VERSION_META_KEY,
  fromJsonSchema,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { Tool } from "effect/unstable/ai";
import { Schema } from "effect";
import { agentToolkit, WRITE_TOOL_NAMES } from "@wfgraph/agent/toolkit";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { readJsonObject } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import type { WorkflowSummaryPayload } from "@wfgraph/shared/graph/api-contracts";
import { workflowSummarySchema } from "@wfgraph/shared/rpc/contracts/workflows";
import type { ServiceFailure } from "#src/backend/lib/effect/failures";
import type { AuthContext } from "#src/backend/lib/http/authorize";
import type {
  DraftToolResult,
  ExecuteDraftToolInput,
} from "#src/backend/services/agent/draft-tool";

export type DraftToolExecution =
  | { readonly ok: true; readonly result: DraftToolResult }
  | { readonly ok: false; readonly failure: ServiceFailure };

export type DraftToolExecutor = (
  input: ExecuteDraftToolInput,
  signal: AbortSignal
) => Promise<DraftToolExecution>;

export type WorkflowListExecution =
  | {
      readonly ok: true;
      readonly workflows: readonly WorkflowSummaryPayload[];
    }
  | { readonly ok: false; readonly failure: ServiceFailure };

export type WorkflowListExecutor = (
  signal: AbortSignal
) => Promise<WorkflowListExecution>;

export type WorkflowCreateExecution =
  | {
      readonly ok: true;
      readonly workflowId: string;
      readonly draftRevision: number;
    }
  | { readonly ok: false; readonly failure: ServiceFailure };

export type WorkflowCreateExecutor = (
  input: { readonly name: string; readonly description?: string | undefined },
  signal: AbortSignal
) => Promise<WorkflowCreateExecution>;

export type CreateAgentMcpServerInput = {
  readonly auth: AuthContext;
  readonly execute: DraftToolExecutor;
  readonly listWorkflows: WorkflowListExecutor;
  readonly createWorkflow: WorkflowCreateExecutor;
};

export type WfGraphMcpOptions = {
  /** Hostnames accepted from the HTTP Host header. Ports are ignored. */
  readonly allowedHostnames: readonly string[];
  /** Hostnames accepted from browser Origin headers. Ports are ignored. */
  readonly allowedOriginHostnames: readonly string[];
};

type McpHttpSecurity = true | WfGraphMcpOptions;

function resolveMcpHttpSecurity(input: McpHttpSecurity): WfGraphMcpOptions {
  return input === true
    ? {
        allowedHostnames: localhostAllowedHostnames(),
        allowedOriginHostnames: localhostAllowedOrigins(),
      }
    : input;
}

/** Rejects untrusted HTTP routing headers before any MCP body is read. */
export function mcpHttpValidationResponse(
  request: Request,
  input: McpHttpSecurity
): Response | undefined {
  const options = resolveMcpHttpSecurity(input);
  return (
    hostHeaderValidationResponse(request, [...options.allowedHostnames]) ??
    originValidationResponse(request, [...options.allowedOriginHostnames])
  );
}

type AgentToolName = keyof typeof agentToolkit.tools;

const WORKFLOW_ID_SCHEMA = {
  type: "string",
  minLength: 1,
  description: "ID of the existing workflow draft to read or edit.",
} as const;

const DRAFT_REVISION_SCHEMA = {
  type: "integer",
  minimum: 1,
  description:
    "Revision returned by the latest read or write. Read the workflow again after a conflict.",
} as const;

const LIST_WORKFLOWS_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const CREATE_WORKFLOW_INPUT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Name of the workflow to create." },
    description: {
      type: "string",
      description: "Optional description of the workflow.",
    },
  },
  required: ["name"],
  additionalProperties: false,
} as const;

const CREATE_WORKFLOW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    workflowId: {
      type: "string",
      description: "ID of the newly created workflow draft.",
    },
    draftRevision: {
      type: "integer",
      minimum: 1,
      description: "Revision of the newly created workflow draft.",
    },
  },
  required: ["workflowId", "draftRevision"],
  additionalProperties: false,
} as const;

const LIST_WORKFLOWS_OUTPUT_SCHEMA = (() => {
  const schema = readJsonObject(
    Tool.getJsonSchemaFromSchema(
      Schema.Struct({ workflows: Schema.Array(workflowSummarySchema) })
    )
  );
  if (!schema) {
    throw new Error("The workflow list has a non-object output schema");
  }
  return schema;
})();

/** Adds persisted-draft fields while retaining the canonical tool schema. */
function inputSchemaFor(name: AgentToolName): JsonObject {
  const canonical = readJsonObject(
    Tool.getJsonSchema(agentToolkit.tools[name])
  );
  if (!canonical) {
    throw new Error(`Tool ${name} has a non-object input schema`);
  }

  const properties = readJsonObject(canonical.properties) ?? {};
  const required = Array.isArray(canonical.required)
    ? canonical.required.filter(
        (value): value is string => typeof value === "string"
      )
    : [];
  const writesGraph = WRITE_TOOL_NAMES.has(name);

  return {
    ...canonical,
    type: "object",
    properties: {
      ...properties,
      workflowId: WORKFLOW_ID_SCHEMA,
      ...(writesGraph ? { expectedDraftRevision: DRAFT_REVISION_SCHEMA } : {}),
    },
    required: [
      ...required,
      "workflowId",
      ...(writesGraph ? ["expectedDraftRevision"] : []),
    ],
    additionalProperties: false,
  };
}

/** Adds persistence identity to the canonical successful result schema. */
function outputSchemaFor(name: AgentToolName): JsonObject {
  const canonical = readJsonObject(
    Tool.getJsonSchemaFromSchema(agentToolkit.tools[name].successSchema)
  );
  if (!canonical) {
    throw new Error(`Tool ${name} has a non-object output schema`);
  }

  const properties = readJsonObject(canonical.properties) ?? {};
  const required = Array.isArray(canonical.required)
    ? canonical.required.filter(
        (value): value is string => typeof value === "string"
      )
    : [];

  return {
    ...canonical,
    type: "object",
    properties: {
      ...properties,
      workflowId: WORKFLOW_ID_SCHEMA,
      draftRevision: DRAFT_REVISION_SCHEMA,
    },
    required: [...required, "workflowId", "draftRevision"],
    additionalProperties: false,
  };
}

function toolDescription(name: AgentToolName, description: string): string {
  return WRITE_TOOL_NAMES.has(name)
    ? `${description} Pass workflowId and the expectedDraftRevision from the latest read or write.`
    : `${description} Pass workflowId to select the persisted draft.`;
}

function isAgentToolName(value: unknown): value is AgentToolName {
  return (
    typeof value === "string" &&
    Object.values(agentToolkit.tools).some((tool) => tool.name === value)
  );
}

function invalidParamsResponse(body: JsonObject, message: string): Response {
  const id = body.id;
  return Response.json(
    {
      jsonrpc: "2.0",
      id: typeof id === "string" || typeof id === "number" ? id : null,
      error: { code: INVALID_PARAMS, message },
    },
    { status: 400 }
  );
}

function requiredOperations(name: AgentToolName) {
  return [
    WfGraphOperations.workflowGetById,
    ...(WRITE_TOOL_NAMES.has(name) ? [WfGraphOperations.workflowUpdate] : []),
    ...(name === "list_integrations"
      ? [WfGraphOperations.integrationGetAll]
      : []),
  ];
}

function toolResult(input: {
  workflowId: string;
  draftRevision?: number | undefined;
  result: JsonObject;
  isError: boolean;
}) {
  const structuredContent = omitUndefined({
    ...input.result,
    workflowId: input.workflowId,
    draftRevision: input.draftRevision,
  });
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(structuredContent) },
    ],
    structuredContent,
    isError: input.isError,
  };
}

function failureResult(workflowId: string, failure: ServiceFailure) {
  return toolResult({
    workflowId,
    draftRevision:
      failure._tag === "DraftConflict"
        ? failure.currentDraftRevision
        : undefined,
    result: omitUndefined({
      reason: failure.error,
      code: failure.payload.code,
    }),
    isError: true,
  });
}

function collectionToolResult(result: JsonObject, isError: boolean) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    isError,
  };
}

/** Creates one MCP server whose calls read and write through the supplied executor. */
export function createAgentMcpServer(
  input: CreateAgentMcpServerInput
): McpServer {
  const server = new McpServer({
    name: "workflow-graph",
    version: "1.0.0",
  });

  const listWorkflowsInput = fromJsonSchema<Record<string, unknown>>(
    LIST_WORKFLOWS_INPUT_SCHEMA
  );
  const listWorkflowsOutput = fromJsonSchema<Record<string, unknown>>(
    LIST_WORKFLOWS_OUTPUT_SCHEMA
  );
  const createWorkflowInput = fromJsonSchema<Record<string, unknown>>(
    CREATE_WORKFLOW_INPUT_SCHEMA
  );
  const createWorkflowOutput = fromJsonSchema<Record<string, unknown>>(
    CREATE_WORKFLOW_OUTPUT_SCHEMA
  );
  server.registerTool<typeof listWorkflowsOutput, typeof listWorkflowsInput>(
    "list_workflows",
    {
      description:
        "List the workflows visible to the authenticated caller. Use a returned workflow ID with workflow authoring tools.",
      inputSchema: listWorkflowsInput,
      outputSchema: listWorkflowsOutput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (_arguments, context) => {
      if (!(await input.auth.allows(WfGraphOperations.workflowGetAll))) {
        return collectionToolResult({ reason: "Forbidden" }, true);
      }

      const outcome = await input.listWorkflows(context.mcpReq.signal);
      if (!outcome.ok) {
        return collectionToolResult(
          omitUndefined({
            reason: outcome.failure.error,
            code: outcome.failure.payload.code,
          }),
          true
        );
      }

      return collectionToolResult(
        {
          workflows: outcome.workflows.map((workflow) =>
            omitUndefined({ ...workflow })
          ),
        },
        false
      );
    }
  );

  server.registerTool<typeof createWorkflowOutput, typeof createWorkflowInput>(
    "create_workflow",
    {
      description:
        "Create a workflow draft with the default Lifecycle node. Use the returned workflow ID and draft revision with workflow authoring tools.",
      inputSchema: createWorkflowInput,
      outputSchema: createWorkflowOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (arguments_, context) => {
      const argumentsObject = readJsonObject(arguments_) ?? {};
      const name = argumentsObject.name;
      if (typeof name !== "string") {
        throw new Error("The validated workflow name is not a string");
      }
      const description = argumentsObject.description;
      if (description !== undefined && typeof description !== "string") {
        throw new Error("The validated workflow description is not a string");
      }

      if (!(await input.auth.allows(WfGraphOperations.workflowCreate))) {
        return collectionToolResult({ reason: "Forbidden" }, true);
      }

      const outcome = await input.createWorkflow(
        {
          name,
          ...(typeof description === "string" ? { description } : {}),
        },
        context.mcpReq.signal
      );
      if (!outcome.ok) {
        return collectionToolResult(
          omitUndefined({
            reason: outcome.failure.error,
            code: outcome.failure.payload.code,
          }),
          true
        );
      }

      return collectionToolResult(
        {
          workflowId: outcome.workflowId,
          draftRevision: outcome.draftRevision,
        },
        false
      );
    }
  );

  for (const tool of Object.values(agentToolkit.tools)) {
    const name = tool.name;
    const inputSchema = fromJsonSchema<Record<string, unknown>>(
      inputSchemaFor(name)
    );
    const outputSchema = fromJsonSchema<Record<string, unknown>>(
      outputSchemaFor(name)
    );

    server.registerTool<typeof outputSchema, typeof inputSchema>(
      name,
      {
        description: toolDescription(name, tool.description ?? ""),
        inputSchema,
        outputSchema,
        annotations: {
          readOnlyHint: !WRITE_TOOL_NAMES.has(name),
          idempotentHint: !WRITE_TOOL_NAMES.has(name),
        },
      },
      async (arguments_, context) => {
        const argumentsObject = readJsonObject(arguments_) ?? {};
        const workflowId = argumentsObject.workflowId;
        if (typeof workflowId !== "string") {
          throw new Error("The validated workflowId is not a string");
        }

        const grants = await Promise.all(
          requiredOperations(name).map(async (operation) =>
            input.auth.allows(operation)
          )
        );
        if (grants.includes(false)) {
          return toolResult({
            workflowId,
            result: { reason: "Forbidden" },
            isError: true,
          });
        }

        const expectedDraftRevision = argumentsObject.expectedDraftRevision;
        const {
          workflowId: _workflowId,
          expectedDraftRevision: _revision,
          ...toolArguments
        } = argumentsObject;
        const outcome = await input.execute(
          {
            workflowId,
            name,
            arguments: toolArguments,
            toolCallId: String(context.mcpReq.id),
            ...(typeof expectedDraftRevision === "number"
              ? { expectedDraftRevision }
              : {}),
          },
          context.mcpReq.signal
        );

        if (!outcome.ok) {
          return failureResult(workflowId, outcome.failure);
        }

        return toolResult({
          workflowId: outcome.result.workflowId,
          draftRevision: outcome.result.draftRevision,
          result: outcome.result.result,
          isError: outcome.result.isFailure,
        });
      }
    );
  }

  return server;
}

/** Creates a modern-only handler whose factory builds one server per request. */
export function createAgentMcpHandler(
  input: CreateAgentMcpServerInput & { readonly httpSecurity?: McpHttpSecurity }
): McpHttpHandler {
  const handler = createMcpHandler(() => createAgentMcpServer(input), {
    legacy: "reject",
  });

  return {
    ...handler,
    fetch: async (request, options) => {
      const rejection = mcpHttpValidationResponse(
        request,
        input.httpSecurity ?? true
      );
      if (rejection) {
        return rejection;
      }

      if (request.method === "POST") {
        try {
          const body = readJsonObject(await request.clone().json());
          const params = readJsonObject(body?.params);
          const meta = readJsonObject(params?.["_meta"]);
          const method = body?.method;
          const name = params?.name;
          const standardHeadersMatch =
            request.headers.get("MCP-Protocol-Version") === "2026-07-28" &&
            request.headers.get("Mcp-Method") === method &&
            (method !== "tools/call" ||
              request.headers.get("Mcp-Name") === name);

          if (
            meta?.[PROTOCOL_VERSION_META_KEY] === "2026-07-28" &&
            standardHeadersMatch
          ) {
            if (
              readJsonObject(meta[CLIENT_INFO_META_KEY]) === null ||
              readJsonObject(meta[CLIENT_CAPABILITIES_META_KEY]) === null
            ) {
              return invalidParamsResponse(
                body ?? {},
                "Request _meta requires client identity and capabilities"
              );
            }

            if (
              method === "tools/call" &&
              (name === "list_workflows" ||
                name === "create_workflow" ||
                isAgentToolName(name))
            ) {
              const schema =
                name === "list_workflows"
                  ? LIST_WORKFLOWS_INPUT_SCHEMA
                  : name === "create_workflow"
                    ? CREATE_WORKFLOW_INPUT_SCHEMA
                    : inputSchemaFor(name);
              const validation = await fromJsonSchema<Record<string, unknown>>(
                schema
              )["~standard"].validate(params?.arguments ?? {});
              if (validation.issues) {
                return invalidParamsResponse(
                  body ?? {},
                  "Invalid tool arguments"
                );
              }
            }
          }
        } catch {
          // The SDK owns JSON and JSON-RPC parse errors.
        }
      }

      return await handler.fetch(request, options);
    },
  };
}
