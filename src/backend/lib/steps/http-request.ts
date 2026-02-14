/**
 * Executable step function for HTTP Request action
 */

import { getErrorMessage } from "@/shared/utils";
import { type StepInput, withStepLogging } from "./step-handler";

type HttpRequestResult =
  | { success: true; data: unknown; status: number }
  | { success: false; error: string; status?: number };

export type HttpRequestInput = StepInput & {
  endpoint: string;
  httpMethod: string;
  httpHeaders?: string;
  httpBody?: string;
};

const HTTP_REQUEST_TIMEOUT_MS = 15_000;
const HTTP_REQUEST_MAX_ATTEMPTS = 2;

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
    return;
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
  input: HttpRequestInput,
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

/**
 * HTTP request logic
 */
async function httpRequest(
  input: HttpRequestInput
): Promise<HttpRequestResult> {
  if (!input.endpoint) {
    return {
      success: false,
      error: "HTTP request failed: URL is required",
    };
  }

  for (let attempt = 1; attempt <= HTTP_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(input, HTTP_REQUEST_TIMEOUT_MS);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");

        if (response.status >= 500 && attempt < HTTP_REQUEST_MAX_ATTEMPTS) {
          continue;
        }

        return {
          success: false,
          error: `HTTP request failed with status ${response.status}: ${errorText}`,
          status: response.status,
        };
      }

      const data = await parseResponse(response);
      return { success: true, data, status: response.status };
    } catch (error) {
      if (attempt < HTTP_REQUEST_MAX_ATTEMPTS) {
        continue;
      }

      if (isTimeoutError(error)) {
        return {
          success: false,
          error: `HTTP request failed: request timed out after ${HTTP_REQUEST_TIMEOUT_MS}ms`,
        };
      }

      return {
        success: false,
        error: `HTTP request failed: ${getErrorMessage(error)}`,
      };
    }
  }

  return {
    success: false,
    error: "HTTP request failed after retries",
  };
}

/**
 * HTTP Request Step
 * Makes an HTTP request to an endpoint
 */
export function httpRequestStep(
  input: HttpRequestInput
): Promise<HttpRequestResult> {
  return withStepLogging(input, () => httpRequest(input));
}
httpRequestStep.maxRetries = 0;
