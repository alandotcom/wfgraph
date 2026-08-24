import { describe, expect, it } from "vitest";
import { WfGraphAppContext } from "#src/backend/lib/effect/app-context";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";

describe("WfGraph runtime application context", () => {
  it("carries the normalized public origin and complete API base path", async () => {
    const runtime = stubWfGraphRuntime({
      appContext: {
        publicUrl: "https://workflows.example.com",
        apiBasePath: "/mounted/api",
      },
    });

    try {
      await expect(runtime.runPromise(WfGraphAppContext)).resolves.toEqual({
        publicUrl: "https://workflows.example.com",
        apiBasePath: "/mounted/api",
      });
    } finally {
      await runtime.dispose();
    }
  });
});
