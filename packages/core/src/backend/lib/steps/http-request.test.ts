import { describe, expect, it } from "bun:test";
import { httpRequestStep } from "./http-request";

describe("httpRequestStep", () => {
  it("returns an error when configured output schema does not match", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "evt_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      const result = await httpRequestStep({
        endpoint: "https://example.com/events",
        httpMethod: "GET",
        httpOutputSchema: JSON.stringify([
          { name: "status", type: "string" },
          { name: "data", type: "object" },
        ]),
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain(
          "HTTP Request output does not match schema"
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts matching output schema for HTTP response payload", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "evt_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      const result = await httpRequestStep({
        endpoint: "https://example.com/events",
        httpMethod: "GET",
        httpOutputSchema: JSON.stringify([
          {
            name: "data",
            type: "object",
            fields: [{ name: "id", type: "string" }],
          },
          { name: "status", type: "number" },
        ]),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.status).toBe(200);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
