import { describe, expect, it } from "vitest";
import { stubStepEnvironment } from "#src/backend/lib/effect/test-layers";
import { httpRequestStep } from "./http-request";

const runHttpRequest = httpRequestStep.implement("HTTP Request")(
  stubStepEnvironment()
);

function stubJsonResponse(body: unknown): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

describe("httpRequestStep", () => {
  it("returns an error when configured output schema does not match", async () => {
    const restore = stubJsonResponse({ id: "evt_123" });

    try {
      const result = await runHttpRequest({
        endpoint: "https://example.com/events",
        httpMethod: "GET",
        httpOutputSchema: JSON.stringify([
          { name: "status", type: "string" },
          { name: "body", type: "object" },
        ]),
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain(
          "HTTP Request output does not match schema"
        );
      }
    } finally {
      restore();
    }
  });

  // The status sits beside the body inside the envelope's payload, which is what
  // `{{@node:HTTP Request.status}}` resolves against once the wrapper is unwrapped.
  it("answers the status beside the response body", async () => {
    const restore = stubJsonResponse({ id: "evt_123" });

    try {
      const result = await runHttpRequest({
        endpoint: "https://example.com/events",
        httpMethod: "GET",
        httpOutputSchema: JSON.stringify([
          {
            name: "body",
            type: "object",
            fields: [{ name: "id", type: "string" }],
          },
          { name: "status", type: "number" },
        ]),
      });

      expect(result).toEqual({
        success: true,
        data: { body: { id: "evt_123" }, status: 200 },
      });
    } finally {
      restore();
    }
  });
});
