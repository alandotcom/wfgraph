/**
 * HTTP Request: the engine's own action for calling an API a plugin does not
 * cover.
 *
 * Its payload is `{ body, status }` inside the ordinary envelope, which is what
 * lets `{{@node:HTTP Request.status}}` resolve: a shape with payload keys beside
 * `success` reads to the template resolver as a plain output, and the status
 * sitting next to the response was swallowed by the unwrap.
 *
 * The response is `body` rather than `data` because `data` is the envelope's own
 * key: a path starting with it names the wrapper, so a payload field called
 * `data` is unreachable through a template.
 *
 * `body` is `Schema.Unknown` because a response body is whatever the API sent --
 * a JSON object, an array, or text. A node that knows more says so in its own
 * output schema, which the editor merges into the paths it offers.
 */

import { Effect, Schema } from "effect";
import { defineStep, StepFailure } from "#src/backend/lib/steps/define-step";
import { getErrorMessage } from "@rova/shared/utils";
import { validateWorkflowOutputAgainstSchema } from "@rova/shared/workflow/schema-validation";

export const httpRequestInput = Schema.Struct({
  endpoint: Schema.optionalKey(Schema.String),
  httpMethod: Schema.optionalKey(Schema.String),
  httpHeaders: Schema.optionalKey(Schema.String),
  httpBody: Schema.optionalKey(Schema.String),
  httpOutputSchema: Schema.optionalKey(Schema.String),
});

export const httpRequestOutput = Schema.Struct({
  body: Schema.Unknown,
  status: Schema.Number.annotate({ description: "HTTP status code" }).check(
    Schema.isFinite()
  ),
});

type HttpRequestInput = typeof httpRequestInput.Type;
type HttpRequestOutput = typeof httpRequestOutput.Type;

const HTTP_REQUEST_TIMEOUT_MS = 15_000;
const HTTP_REQUEST_MAX_ATTEMPTS = 2;
const DEFAULT_HTTP_METHOD = "GET";

function parseHeaders(httpHeaders?: string): Record<string, string> {
  if (!httpHeaders) {
    return {};
  }
  try {
    return JSON.parse(httpHeaders);
  } catch {
    return {};
  }
}

function parseBody(httpMethod: string, httpBody?: string): string | undefined {
  if (httpMethod === "GET" || !httpBody) {
    return undefined;
  }
  try {
    const parsedBody = JSON.parse(httpBody);
    return Object.keys(parsedBody).length > 0
      ? JSON.stringify(parsedBody)
      : undefined;
  } catch {
    const trimmed = httpBody.trim();
    return trimmed && trimmed !== "{}" ? httpBody : undefined;
  }
}

function parseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "AbortError";
}

async function fetchWithTimeout(
  input: { endpoint: string; httpMethod: string } & HttpRequestInput,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input.endpoint, {
      method: input.httpMethod,
      headers: parseHeaders(input.httpHeaders),
      body: parseBody(input.httpMethod, input.httpBody),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

type HttpRequestOutcome =
  | { ok: true; output: HttpRequestOutput }
  | { ok: false; error: string };

async function httpRequest(
  input: HttpRequestInput
): Promise<HttpRequestOutcome> {
  const endpoint = input.endpoint?.trim();
  if (!endpoint) {
    return { ok: false, error: "HTTP request failed: URL is required" };
  }

  const request = {
    ...input,
    endpoint,
    httpMethod: input.httpMethod ?? DEFAULT_HTTP_METHOD,
  };

  const runAttempt = async (attempt: number): Promise<HttpRequestOutcome> => {
    try {
      const response = await fetchWithTimeout(request, HTTP_REQUEST_TIMEOUT_MS);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");

        if (response.status >= 500 && attempt < HTTP_REQUEST_MAX_ATTEMPTS) {
          return await runAttempt(attempt + 1);
        }

        return {
          ok: false,
          error: `HTTP request failed with status ${response.status}: ${errorText}`,
        };
      }

      const output: HttpRequestOutput = {
        body: await parseResponse(response),
        status: response.status,
      };
      const schemaValidation = validateWorkflowOutputAgainstSchema({
        schemaValue: input.httpOutputSchema,
        output,
        contextLabel: "HTTP Request",
      });

      if (!schemaValidation.ok) {
        return { ok: false, error: schemaValidation.error };
      }

      return { ok: true, output };
    } catch (error) {
      if (attempt < HTTP_REQUEST_MAX_ATTEMPTS) {
        return await runAttempt(attempt + 1);
      }

      if (isTimeoutError(error)) {
        return {
          ok: false,
          error: `HTTP request failed: request timed out after ${HTTP_REQUEST_TIMEOUT_MS}ms`,
        };
      }

      return {
        ok: false,
        error: `HTTP request failed: ${getErrorMessage(error)}`,
      };
    }
  };

  return await runAttempt(1);
}

export const httpRequestStep = defineStep({
  label: "HTTP Request",
  description: "Make an HTTP request to any API",
  category: "System",
  // The editor configures this node through a panel of its own, so there is no
  // declarative field list to render.
  configFields: [],
  input: httpRequestInput,
  output: httpRequestOutput,
  handler: (input) =>
    Effect.flatMap(
      // The attempt loop, the timeout and the body parsing are all inside this
      // one Promise: it retries a 5xx once on its own because a node that calls
      // a flaky API should not spend an Inngest function retry on it.
      Effect.promise(() => httpRequest(input)),
      (outcome) =>
        outcome.ok
          ? Effect.succeed(outcome.output)
          : Effect.fail(new StepFailure({ message: outcome.error }))
    ),
});
