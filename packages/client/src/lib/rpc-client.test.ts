import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLICATION_CONFLICT_CODES } from "@wfgraph/shared/rpc/error-codes";
import { rpcErrorResponse } from "#src/lib/rpc-fetch-test-support";
import { ApiError, resolveRpcUrl, rpc } from "./rpc-client";

describe("resolveRpcUrl", () => {
  it("returns absolute URLs unchanged", () => {
    expect(
      resolveRpcUrl({
        rpcUrl: "https://api.example.com/api/rpc",
        origin: "https://app.example.com",
      })
    ).toBe("https://api.example.com/api/rpc");
  });

  it("resolves relative URLs against the runtime origin", () => {
    expect(
      resolveRpcUrl({
        rpcUrl: "/api/rpc",
        origin: "https://app.example.com",
      })
    ).toBe("https://app.example.com/api/rpc");
  });

  it("uses the default RPC path when configured URL is empty", () => {
    expect(
      resolveRpcUrl({
        rpcUrl: "   ",
        origin: "https://app.example.com",
      })
    ).toBe("https://app.example.com/api/rpc");
  });

  it("falls back to localhost when no valid origin is available", () => {
    expect(
      resolveRpcUrl({
        rpcUrl: "/api/rpc",
        origin: null,
      })
    ).toBe("http://localhost:3000/api/rpc");
  });

  it("uses default RPC path when rpcUrl is omitted", () => {
    expect(
      resolveRpcUrl({
        origin: "https://app.example.com",
      })
    ).toBe("https://app.example.com/api/rpc");
  });
});

/**
 * What a failed call leaves the RPC link as.
 *
 * `ApiError` is the last place in the client that speaks HTTP, and now also the
 * place a server's machine-readable code arrives. Everything here goes through
 * the real link, so a change to the interceptor or to the wire envelope is
 * caught rather than a hand-built error object.
 */
describe("ApiError from a failed call", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function failedCall(answer: Response | Error): Promise<unknown> {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    });

    return rpc.workflow
      .getById({ workflowId: "wf_1" })
      .then(() => undefined)
      .catch((error: unknown) => error);
  }

  it("keeps the machine-readable code a coded failure carries", async () => {
    const error = await failedCall(
      rpcErrorResponse({
        code: "CONFLICT",
        status: 409,
        message:
          "This workflow was published elsewhere. Refresh and try again.",
        data: {
          error:
            "This workflow was published elsewhere. Refresh and try again.",
          code: PUBLICATION_CONFLICT_CODES.stale,
        },
      })
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      message: "This workflow was published elsewhere. Refresh and try again.",
      code: "workflow_publish_stale",
    });
  });

  it("leaves the code unset when the failure carries none", async () => {
    const error = await failedCall(
      rpcErrorResponse({
        code: "CONFLICT",
        status: 409,
        message: "Name already taken",
        data: { error: "Name already taken" },
      })
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, message: "Name already taken" });
    expect((error as ApiError).code).toBeUndefined();
  });

  // A payload whose `code` is not a string, and one that is not an object at
  // all, are both something no branch should fire on.
  it("ignores a code that is not a string", async () => {
    const error = await failedCall(
      rpcErrorResponse({
        code: "BAD_REQUEST",
        status: 400,
        message: "Graph is malformed",
        data: { error: "Graph is malformed", code: 7 },
      })
    );

    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).message).toBe("Graph is malformed");
    expect((error as ApiError).code).toBeUndefined();
  });

  it("carries no code when the payload is not an object", async () => {
    const error = await failedCall(
      rpcErrorResponse({
        code: "BAD_REQUEST",
        status: 400,
        message: "Graph is malformed",
        data: "Graph is malformed",
      })
    );

    expect((error as ApiError).message).toBe("Graph is malformed");
    expect((error as ApiError).code).toBeUndefined();
  });

  // A body oRPC cannot read as one of its errors: the link answers with its own
  // MALFORMED_ORPC_ERROR_RESPONSE, which maps to no status of its own.
  it("falls back for a response that is not an oRPC error", async () => {
    const error = await failedCall(
      new Response(JSON.stringify({ json: { oops: true } }), {
        status: 502,
        headers: { "content-type": "application/json" },
      })
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(500);
    expect((error as ApiError).message).toBe("Request failed");
    expect((error as ApiError).code).toBeUndefined();
  });

  it("wraps a transport failure that never reached the server", async () => {
    const error = await failedCall(new TypeError("Failed to fetch"));

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(500);
    expect((error as ApiError).message).toBe("Failed to fetch");
    expect((error as ApiError).code).toBeUndefined();
  });
});
