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
  type JsonSchemaType,
  type McpHttpHandler,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { Tool } from "effect/ai";
import { Result, Schema, type SchemaAST } from "effect";
import { buildAuthoringInstructions } from "@wfgraph/agent/prompt";
import { agentToolkit, WRITE_TOOL_NAMES } from "@wfgraph/agent/toolkit";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { readJsonObject } from "@wfgraph/shared/types/json";
import {
  NonEmptyTrimmedString,
  positiveInteger,
} from "@wfgraph/shared/types/schema";
import { formatSchemaFailure } from "@wfgraph/shared/types/schema-message";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import type { WorkflowSummaryPayload } from "@wfgraph/shared/graph/api-contracts";
import { workflowSummarySchema } from "@wfgraph/shared/rpc/contracts/workflows";
import type { ServiceFailure } from "#src/backend/lib/effect/failures";
import type { AuthContext } from "#src/backend/lib/http/authorize";
import { agentToolOperations } from "#src/backend/agent/tool-permissions";
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

/**
 * Canonical tools this transport does not expose.
 *
 * `revert_draft` returns the graph to the state its turn began in. A turn is
 * one chat request holding the document in memory, so there is a state to go
 * back to. An MCP call is its own request against the persisted draft, which
 * makes the state it began in the state it is already in, and the tool a
 * no-op wearing a useful name. An external client undoes its own edits by
 * making the opposite ones.
 */
const TOOLS_WITHOUT_AN_MCP_MEANING: ReadonlySet<string> = new Set([
  "revert_draft",
]);

/**
 * The most array elements and object members one call's arguments may hold.
 * A tool edits one node, one edge or one rule set, and the largest honest
 * argument, a list of every node id in a graph at `MAX_AGENT_GRAPH_NODES`, is
 * five hundred. A call over the limit is answered as a tool error before its
 * arguments are validated.
 */
const MAX_TOOL_INPUT_ELEMENTS = 10_000;

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

const LIST_WORKFLOWS_ARGUMENTS = Schema.Struct({});

const CREATE_WORKFLOW_ARGUMENTS = Schema.Struct({
  name: NonEmptyTrimmedString.annotate({
    description: "Name of the workflow to create.",
  }),
  description: Schema.optionalKey(Schema.String).annotate({
    description: "Optional description of the workflow.",
  }),
});

/** The persisted-draft fields a workflow tool reads beside its own arguments. */
const WORKFLOW_READ_ARGUMENTS = Schema.Struct({
  workflowId: NonEmptyTrimmedString,
});

const WORKFLOW_WRITE_ARGUMENTS = Schema.Struct({
  workflowId: NonEmptyTrimmedString,
  expectedDraftRevision: positiveInteger,
});

/**
 * How a tool's declared arguments are read. `errors: "all"` lets the refusal
 * name every field that was wrong in one answer, and `formatSchemaFailure`
 * renders them without quoting a rejected value. Unknown keys are reported
 * against the listed schema's properties, which covers a tool with no
 * arguments: Effect reads an empty Struct as an open object.
 */
const ARGUMENT_DECODE_OPTIONS = {
  errors: "all",
} as const satisfies SchemaAST.ParseOptions;

/**
 * Every argument problem of one call as `path: message` sentences, or
 * undefined when the arguments are valid. `transport` holds the persisted-draft
 * fields read off the same object, `own` the tool's declared arguments, read
 * with those transport keys removed, and `listed` the JSON Schema the client
 * was shown, whose properties are the only keys a call may send.
 */
function argumentProblems(input: {
  readonly listed: JsonObject;
  readonly transport: Schema.Codec<unknown, unknown> | undefined;
  readonly own: Schema.Codec<unknown, unknown>;
  readonly value: unknown;
}): string | undefined {
  const value = readJsonObject(input.value) ?? {};
  const { workflowId: _id, expectedDraftRevision: _revision, ...own } = value;
  const allowedKeys = Object.keys(
    readJsonObject(input.listed.properties) ?? {}
  );
  const unexpectedKeys = Object.keys(value)
    .filter((key) => !allowedKeys.includes(key))
    .map((key) => `${key}: Unexpected key`);
  const transport =
    input.transport === undefined
      ? undefined
      : Schema.decodeUnknownResult(Schema.toCodecJson(input.transport))(
          value,
          ARGUMENT_DECODE_OPTIONS
        );
  const declared = Schema.decodeUnknownResult(Schema.toCodecJson(input.own))(
    input.transport === undefined ? value : own,
    ARGUMENT_DECODE_OPTIONS
  );
  const problems = [
    ...unexpectedKeys,
    ...[transport, declared].flatMap((result) =>
      result !== undefined && Result.isFailure(result)
        ? [formatSchemaFailure(result.failure.issue)]
        : []
    ),
  ];
  return problems.length === 0 ? undefined : problems.join("; ");
}

/**
 * The listed JSON Schema with the validation above in place of the SDK's own.
 * The SDK answers a failed validation as an `isError` tool result carrying the
 * message, which a model reads and corrects; the specification classes input
 * validation errors as tool execution errors for that reason.
 */
function argumentsSchema(input: {
  readonly listed: JsonObject;
  readonly transport: Schema.Codec<unknown, unknown> | undefined;
  readonly own: Schema.Codec<unknown, unknown>;
}): StandardSchemaWithJSON<Record<string, unknown>> {
  const listed = fromJsonSchema<Record<string, unknown>>(input.listed);
  return {
    "~standard": {
      ...listed["~standard"],
      validate: (value: unknown) => {
        const problems = argumentProblems({ ...input, value });
        return problems === undefined
          ? { value: readJsonObject(value) ?? {} }
          : { issues: [{ message: problems }] };
      },
    },
  };
}

function jsonSchemaOf(schema: Schema.Top, label: string): JsonObject {
  const json = readJsonObject(Tool.getJsonSchemaFromSchema(schema));
  if (!json) {
    throw new Error(`${label} has a non-object schema`);
  }
  return json;
}

const LIST_WORKFLOWS_INPUT_SCHEMA = {
  ...jsonSchemaOf(LIST_WORKFLOWS_ARGUMENTS, "list_workflows"),
  additionalProperties: false,
};

const CREATE_WORKFLOW_INPUT_SCHEMA = {
  ...jsonSchemaOf(CREATE_WORKFLOW_ARGUMENTS, "create_workflow"),
  additionalProperties: false,
};

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

/**
 * Each tool's JSON Schemas and the Standard Schema validators built from them,
 * made once. The toolkit is fixed at module load, while the SDK wants a new
 * server per request, and both the server and the pre-check below read these.
 */
type ToolSchemas = {
  readonly input: StandardSchemaWithJSON<Record<string, unknown>>;
  readonly output: StandardSchemaWithJSON<Record<string, unknown>>;
};

const COLLECTION_TOOL_SCHEMAS = {
  list_workflows: {
    input: argumentsSchema({
      listed: LIST_WORKFLOWS_INPUT_SCHEMA,
      transport: undefined,
      own: LIST_WORKFLOWS_ARGUMENTS,
    }),
    output: fromJsonSchema<Record<string, unknown>>(
      LIST_WORKFLOWS_OUTPUT_SCHEMA
    ),
  },
  create_workflow: {
    input: argumentsSchema({
      listed: CREATE_WORKFLOW_INPUT_SCHEMA,
      transport: undefined,
      own: CREATE_WORKFLOW_ARGUMENTS,
    }),
    output: fromJsonSchema<Record<string, unknown>>(
      CREATE_WORKFLOW_OUTPUT_SCHEMA
    ),
  },
} satisfies Record<string, ToolSchemas>;

const AGENT_TOOL_SCHEMAS: ReadonlyMap<string, ToolSchemas> = new Map(
  Object.values(agentToolkit.tools)
    .filter((tool) => !TOOLS_WITHOUT_AN_MCP_MEANING.has(tool.name))
    .map((tool) => [
      tool.name,
      {
        input: argumentsSchema({
          listed: inputSchemaFor(tool.name),
          transport: WRITE_TOOL_NAMES.has(tool.name)
            ? WORKFLOW_WRITE_ARGUMENTS
            : WORKFLOW_READ_ARGUMENTS,
          own: tool.parametersSchema,
        }),
        output: fromJsonSchema<Record<string, unknown>>(
          outputSchemaFor(tool.name)
        ),
      } satisfies ToolSchemas,
    ])
);

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

/**
 * The authoring rules, fixed at module load. The built-in agent reads the same
 * text as its system prompt, so an MCP client and the chat panel build to one
 * set of rules.
 */
const AUTHORING_INSTRUCTIONS = buildAuthoringInstructions();

const BUILD_WORKFLOW_ARGUMENTS = fromJsonSchema<Record<string, unknown>>({
  type: "object",
  properties: {
    request: {
      type: "string",
      description: "What the workflow should do, in the person's own words.",
    },
  },
  additionalProperties: false,
});

/**
 * The `build_workflow` prompt: the authoring rules followed by the request, for
 * a client that surfaces prompts and does not hand a model the instructions.
 */
function buildWorkflowPrompt(request: unknown) {
  const ask =
    typeof request === "string" && request.trim() !== ""
      ? `Build this workflow:\n\n${request}`
      : "Ask what the workflow should do, then build it.";
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `${AUTHORING_INSTRUCTIONS}\n\n${ask}`,
        },
      },
    ],
  };
}

/** Creates one MCP server whose calls read and write through the supplied executor. */
export function createAgentMcpServer(
  input: CreateAgentMcpServerInput
): McpServer {
  const server = new McpServer(
    { name: "workflow-graph", version: "1.0.0" },
    {
      instructions: AUTHORING_INSTRUCTIONS,
      // The endpoint keeps no session and opens no listen stream, so it never
      // sends a list-changed notification, and says so.
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
      },
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
    }
  );

  server.registerPrompt(
    "build_workflow",
    {
      title: "Build a workflow",
      description:
        "The rules for authoring a Workflow Graph workflow with these tools, followed by the workflow to build.",
      argsSchema: BUILD_WORKFLOW_ARGUMENTS,
    },
    (arguments_) => buildWorkflowPrompt(readJsonObject(arguments_)?.request)
  );

  const listWorkflows = COLLECTION_TOOL_SCHEMAS.list_workflows;
  const createWorkflow = COLLECTION_TOOL_SCHEMAS.create_workflow;
  server.registerTool<typeof listWorkflows.output, typeof listWorkflows.input>(
    "list_workflows",
    {
      description:
        "List the workflows visible to the authenticated caller. Use a returned workflow ID with workflow authoring tools.",
      inputSchema: listWorkflows.input,
      outputSchema: listWorkflows.output,
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

  server.registerTool<
    typeof createWorkflow.output,
    typeof createWorkflow.input
  >(
    "create_workflow",
    {
      description:
        "Create a workflow draft with the default Lifecycle node. Use the returned workflow ID and draft revision with workflow authoring tools.",
      inputSchema: createWorkflow.input,
      outputSchema: createWorkflow.output,
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
    const schemas = AGENT_TOOL_SCHEMAS.get(name);
    if (!schemas) {
      continue;
    }

    server.registerTool<typeof schemas.output, typeof schemas.input>(
      name,
      {
        description: toolDescription(name, tool.description ?? ""),
        inputSchema: schemas.input,
        outputSchema: schemas.output,
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
          agentToolOperations(name).map(async (operation) =>
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

/**
 * Creates a handler whose factory builds one server per request. A 2026-07-28
 * request is served directly; a 2025-era request (protocol revisions
 * 2024-10-07 through 2025-11-25) is served by the SDK's stateless legacy path,
 * which answers `initialize` from a fresh server and refuses the session
 * methods `GET` and `DELETE` with 405. The server keeps no state between calls
 * in either era, so both serve the same tools against the same stored draft.
 */
export function createAgentMcpHandler(
  input: CreateAgentMcpServerInput & { readonly httpSecurity?: McpHttpSecurity }
): McpHttpHandler {
  const handler = createMcpHandler(() => createAgentMcpServer(input), {
    legacy: "stateless",
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
          const body = readJsonObject(
            options?.parsedBody ?? (await request.clone().json())
          );
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
          }
        } catch {
          // The SDK owns JSON and JSON-RPC parse errors.
        }
      }

      return await handler.fetch(request, options);
    },
  };
}
