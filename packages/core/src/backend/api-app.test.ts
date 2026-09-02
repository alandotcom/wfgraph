import { afterAll, describe, expect, it } from "vitest";
import { resetSync } from "@logtape/logtape";
import { createApiApp } from "#src/backend/api-app";
import {
  resolveAuth,
  trustWfGraphUpstream,
} from "#src/backend/lib/http/authorize";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import { configureLoggingWithBridge } from "#src/backend/lib/log-config";

const basePath = "/wfgraph/api" as const;

/** Captures the structured fields of every record the request middleware wrote. */
function captureRequestFields(): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const take = (properties: unknown) => {
    if (typeof properties === "object" && properties !== null) {
      records.push(properties as Record<string, unknown>);
    }
  };
  configureLoggingWithBridge(
    {
      debug: (_message, properties) => take(properties),
      info: (_message, properties) => take(properties),
      warn: (_message, properties) => take(properties),
      error: (_message, properties) => take(properties),
    },
    "debug"
  );
  return records;
}

describe("the request log record", () => {
  it("leaves the rpc group out of a request that addressed no procedure", async () => {
    const records = captureRequestFields();
    await using runtime = stubWfGraphRuntime({});
    const app = createApiApp({
      basePath,
      auth: resolveAuth(trustWfGraphUpstream()),
      runtime,
    });

    await app.fetch(new Request(`http://localhost${basePath}/nothing-here`));

    // The pretty formatter prints a line per top-level field, so an `rpc` key
    // holding `undefined` reaches the reader as a bare `rpc: undefined` line.
    const request = records.find((fields) => fields["http"] !== undefined);
    expect(request).toBeDefined();
    expect(request && "rpc" in request).toBe(false);
  });
});

// Back to unconfigured, which is logtape's own default and what every other
// file in this worker expects: the suite shares one module graph.
afterAll(() => {
  resetSync();
});
