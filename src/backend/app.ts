import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { serve as serveInngest } from "inngest/hono";
import { z } from "zod";
import { respond } from "@/backend/lib/http/respond";
import { inngest } from "@/backend/lib/inngest/client";
import { getInngestFunctions } from "@/backend/lib/inngest/functions";
import { getAppLogger } from "@/backend/lib/logger";
import { initializeWorkflowTriggers } from "@/backend/lib/workflow-trigger-bootstrap";
import { serializedWorkflowGraphSchema } from "@/shared/workflow/schemas";
import {
  deleteApiKey,
  deleteIntegration,
  deleteWorkflow,
  deleteWorkflowExecutions,
  getApiKeys,
  getExecutionEvents,
  getExecutionLogs,
  getExecutionStatus,
  getIntegration,
  getIntegrations,
  getWorkflow,
  getWorkflowExecutions,
  getWorkflows,
  getWorkflowsCurrent,
  optionsWorkflowWebhook,
  patchWorkflow,
  postApiKeys,
  postExecutionCancel,
  postIntegrations,
  postIntegrationsTest,
  postIntegrationTest,
  postWorkflowDuplicate,
  postWorkflowExecute,
  postWorkflowResume,
  postWorkflowsCreate,
  postWorkflowsCurrent,
  postWorkflowWebhook,
  putIntegration,
} from "./server/routes";

const idSchema = z.string().trim().min(1);
const integrationTypeSchema = z.enum([
  "acuity",
  "clerk",
  "database",
  "linear",
  "resend",
  "slack",
  "twilio",
]);
const workflowIdParamsSchema = z.object({ workflowId: idSchema });
const integrationIdParamsSchema = z.object({ integrationId: idSchema });
const executionIdParamsSchema = z.object({ executionId: idSchema });
const apiKeyIdParamsSchema = z.object({ keyId: idSchema });
const tokenParamsSchema = z.object({ token: idSchema });
const integrationQuerySchema = z.object({
  type: integrationTypeSchema.optional(),
});
const webhookQuerySchema = z.object({
  dryRun: z.enum(["true", "false"]).optional(),
});
const integrationConfigSchema = z.record(z.string(), z.string().optional());

const createApiKeySchema = z
  .object({
    name: z.string().optional(),
  })
  .passthrough();

const integrationCreateSchema = z
  .object({
    name: z.string().optional(),
    type: integrationTypeSchema,
    config: integrationConfigSchema,
  })
  .passthrough();

const integrationUpdateSchema = z
  .object({
    name: z.string().optional(),
    config: integrationConfigSchema.optional(),
  })
  .passthrough();

const integrationTestSchema = z
  .object({
    type: integrationTypeSchema,
    config: integrationConfigSchema,
  })
  .passthrough();

const workflowCreateSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    graph: serializedWorkflowGraphSchema,
  })
  .passthrough();

const workflowCurrentSaveSchema = z
  .object({
    graph: serializedWorkflowGraphSchema,
  })
  .passthrough();

const workflowPatchSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    graph: serializedWorkflowGraphSchema.optional(),
  })
  .passthrough();

const executeWorkflowSchema = z
  .object({
    input: z.record(z.string(), z.unknown()).optional(),
    dryRun: z.boolean().optional(),
  })
  .passthrough();

const webhookBodySchema = z.record(z.string(), z.unknown());
const resumeBodySchema = z.record(z.string(), z.unknown());

initializeWorkflowTriggers();

const app = new Hono().basePath("/api");
const httpLogger = getAppLogger("http", "hono");

const BODY_LOG_LIMIT = 8192;
const isDevelopmentEnvironment = ["development", "dev"].includes(
  (Bun.env.NODE_ENV ?? "").trim().toLowerCase()
);
const LOG_HTTP_BODIES = isDevelopmentEnvironment;
const JSON_CONTENT_TYPES = [
  "application/json",
  "application/problem+json",
  "application/ld+json",
];
const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }
  const normalized = contentType.toLowerCase();
  return JSON_CONTENT_TYPES.some((jsonType) => normalized.includes(jsonType));
}

function buildRequestId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function truncateTextForLogs(text: string): {
  value: string;
  truncated: boolean;
  originalLength: number;
} {
  if (text.length <= BODY_LOG_LIMIT) {
    return { value: text, truncated: false, originalLength: text.length };
  }

  return {
    value: text.slice(0, BODY_LOG_LIMIT),
    truncated: true,
    originalLength: text.length,
  };
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function getRequestLogBody(req: Request): Promise<unknown | undefined> {
  if (!METHODS_WITH_BODY.has(req.method.toUpperCase())) {
    return;
  }

  const contentType = req.headers.get("content-type") ?? undefined;
  if (!isJsonContentType(contentType)) {
    return;
  }

  const rawBody = await req.clone().text();
  if (!rawBody) {
    return;
  }

  const truncated = truncateTextForLogs(rawBody);
  const parsedValue = safeParseJson(truncated.value);

  if (!truncated.truncated) {
    return parsedValue;
  }

  return {
    truncated: true,
    originalLength: truncated.originalLength,
    value: parsedValue,
  };
}

async function getResponseLogBody(res: Response): Promise<unknown | undefined> {
  const contentType = res.headers.get("content-type") ?? undefined;
  if (!isJsonContentType(contentType)) {
    return;
  }

  const rawBody = await res.clone().text();
  if (!rawBody) {
    return;
  }

  const truncated = truncateTextForLogs(rawBody);
  const parsedValue = safeParseJson(truncated.value);

  if (!truncated.truncated) {
    return parsedValue;
  }

  return {
    truncated: true,
    originalLength: truncated.originalLength,
    value: parsedValue,
  };
}

app.use("*", async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? buildRequestId();
  const startTime = Date.now();
  const method = c.req.method.toUpperCase();
  const path = c.req.path;
  const query = c.req.query();
  const requestBody = LOG_HTTP_BODIES
    ? await getRequestLogBody(c.req.raw)
    : undefined;
  const requestLogger = httpLogger.with({ requestId });

  requestLogger.info(`--> ${method} ${path} [${requestId}]`, {
    method,
    path,
    query,
    requestBody,
    userAgent: c.req.header("user-agent") ?? null,
    ip:
      c.req.header("x-forwarded-for") ??
      c.req.header("x-real-ip") ??
      c.req.header("cf-connecting-ip") ??
      null,
  });

  try {
    await next();
  } catch (error) {
    requestLogger.error(`xx> ${method} ${path} [${requestId}]`, {
      method,
      path,
      durationMs: Date.now() - startTime,
      error,
    });
    throw error;
  }

  const status = c.res.status;
  const responseBody =
    LOG_HTTP_BODIES && status >= 400
      ? await getResponseLogBody(c.res)
      : undefined;
  const responseLog = {
    method,
    path,
    statusCode: status,
    durationMs: Date.now() - startTime,
    responseBody,
  };
  const responseSummary = `<-- ${method} ${path} ${status} ${responseLog.durationMs}ms [${requestId}]`;

  if (status >= 500) {
    requestLogger.error(responseSummary, responseLog);
  } else if (status >= 400) {
    requestLogger.warn(responseSummary, responseLog);
  } else {
    requestLogger.info(responseSummary, responseLog);
  }
});

app.onError((error, c) => {
  httpLogger.error("Unhandled API error", {
    method: c.req.method.toUpperCase(),
    path: c.req.path,
    query: c.req.query(),
    error,
  });

  return c.json({ error: "Internal Server Error" }, 500);
});

const routes = app
  .all("/auth", (c) => c.json({ error: "Not found" }, 404))
  .all("/auth/*", (c) => c.json({ error: "Not found" }, 404))
  .all("/og", (c) => c.json({ error: "Not found" }, 404))
  .all("/og/*", (c) => c.json({ error: "Not found" }, 404))
  .on(["GET", "POST", "PUT"], "/inngest", async (c) => {
    const functions = await getInngestFunctions();
    const inngestHandler = serveInngest({ client: inngest, functions });
    return await inngestHandler(c);
  })
  .get("/api-keys", () => getApiKeys())
  .post("/api-keys", zValidator("json", createApiKeySchema), (c) =>
    postApiKeys(c.req.valid("json"))
  )
  .delete("/api-keys/:keyId", zValidator("param", apiKeyIdParamsSchema), (c) =>
    deleteApiKey(c.req.valid("param").keyId)
  )
  .get("/integrations", zValidator("query", integrationQuerySchema), (c) =>
    getIntegrations(c.req.valid("query").type)
  )
  .post("/integrations", zValidator("json", integrationCreateSchema), (c) =>
    postIntegrations(c.req.valid("json"))
  )
  .post("/integrations/test", zValidator("json", integrationTestSchema), (c) =>
    postIntegrationsTest(c.req.valid("json"))
  )
  .get(
    "/integrations/:integrationId",
    zValidator("param", integrationIdParamsSchema),
    (c) => getIntegration(c.req.valid("param").integrationId)
  )
  .put(
    "/integrations/:integrationId",
    zValidator("param", integrationIdParamsSchema),
    zValidator("json", integrationUpdateSchema),
    (c) =>
      putIntegration(c.req.valid("param").integrationId, c.req.valid("json"))
  )
  .delete(
    "/integrations/:integrationId",
    zValidator("param", integrationIdParamsSchema),
    (c) => deleteIntegration(c.req.valid("param").integrationId)
  )
  .post(
    "/integrations/:integrationId/test",
    zValidator("param", integrationIdParamsSchema),
    (c) => postIntegrationTest(c.req.valid("param").integrationId)
  )
  .post(
    "/workflow/:workflowId/execute",
    zValidator("param", workflowIdParamsSchema),
    zValidator("json", executeWorkflowSchema),
    (c) =>
      postWorkflowExecute(c.req.valid("param").workflowId, c.req.valid("json"))
  )
  .get("/workflows", async (c) => {
    return respond(c, await getWorkflows());
  })
  .post(
    "/workflows/create",
    zValidator("json", workflowCreateSchema),
    async (c) => respond(c, await postWorkflowsCreate(c.req.valid("json")))
  )
  .get("/workflows/current", async (c) =>
    respond(c, await getWorkflowsCurrent())
  )
  .post(
    "/workflows/current",
    zValidator("json", workflowCurrentSaveSchema),
    async (c) => respond(c, await postWorkflowsCurrent(c.req.valid("json")))
  )
  .get(
    "/workflows/:workflowId",
    zValidator("param", workflowIdParamsSchema),
    async (c) => respond(c, await getWorkflow(c.req.valid("param").workflowId))
  )
  .patch(
    "/workflows/:workflowId",
    zValidator("param", workflowIdParamsSchema),
    zValidator("json", workflowPatchSchema),
    async (c) =>
      respond(
        c,
        await patchWorkflow(
          c.req.valid("param").workflowId,
          c.req.valid("json")
        )
      )
  )
  .delete(
    "/workflows/:workflowId",
    zValidator("param", workflowIdParamsSchema),
    async (c) =>
      respond(c, await deleteWorkflow(c.req.valid("param").workflowId))
  )
  .post(
    "/workflows/:workflowId/duplicate",
    zValidator("param", workflowIdParamsSchema),
    async (c) =>
      respond(c, await postWorkflowDuplicate(c.req.valid("param").workflowId))
  )
  .get(
    "/workflows/:workflowId/executions",
    zValidator("param", workflowIdParamsSchema),
    (c) => getWorkflowExecutions(c.req.valid("param").workflowId)
  )
  .delete(
    "/workflows/:workflowId/executions",
    zValidator("param", workflowIdParamsSchema),
    (c) => deleteWorkflowExecutions(c.req.valid("param").workflowId)
  )
  .options("/workflows/:workflowId/webhook", () => optionsWorkflowWebhook())
  .post(
    "/workflows/:workflowId/webhook",
    zValidator("param", workflowIdParamsSchema),
    zValidator("query", webhookQuerySchema),
    zValidator("json", webhookBodySchema),
    (c) =>
      postWorkflowWebhook({
        workflowId: c.req.valid("param").workflowId,
        authHeader: c.req.header("Authorization") ?? null,
        dryRunQuery: c.req.valid("query").dryRun,
        dryRunHeader: c.req.header("x-workflow-dry-run") ?? null,
        body: c.req.valid("json"),
      })
  )
  .get(
    "/workflows/executions/:executionId/status",
    zValidator("param", executionIdParamsSchema),
    (c) => getExecutionStatus(c.req.valid("param").executionId)
  )
  .get(
    "/workflows/executions/:executionId/logs",
    zValidator("param", executionIdParamsSchema),
    (c) => getExecutionLogs(c.req.valid("param").executionId)
  )
  .get(
    "/workflows/executions/:executionId/events",
    zValidator("param", executionIdParamsSchema),
    (c) => getExecutionEvents(c.req.valid("param").executionId)
  )
  .post(
    "/workflows/executions/:executionId/cancel",
    zValidator("param", executionIdParamsSchema),
    (c) => postExecutionCancel(c.req.valid("param").executionId)
  )
  .post(
    "/workflows/hooks/:token/resume",
    zValidator("param", tokenParamsSchema),
    zValidator("json", resumeBodySchema),
    (c) =>
      postWorkflowResume(
        c.req.valid("param").token,
        c.req.valid("json"),
        c.req.header("Authorization") ?? null
      )
  );

routes.notFound((c) => c.json({ error: "Not found" }, 404));

export type AppType = typeof routes;

export { routes as app };
