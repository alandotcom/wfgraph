import { describe, expect, it } from "vitest";
import { resolveRpcUrl } from "./rpc-client";

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
