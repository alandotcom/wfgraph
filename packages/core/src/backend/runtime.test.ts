import { describe, expect, it } from "vitest";
import { WfGraphAppContext } from "#src/backend/lib/effect/app-context";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";

describe("WfGraph runtime application context", () => {
  it("derives one OAuth topology from the public origin and API base path", async () => {
    const runtime = stubWfGraphRuntime({
      appContext: {
        publicUrl: "https://workflows.example.com",
        apiBasePath: "/mounted/api",
      },
    });

    try {
      const context = await runtime.runPromise(WfGraphAppContext);
      expect(context.apiBasePath).toBe("/mounted/api");
      expect(context.oauth).toMatchObject({
        publicUrl: "https://workflows.example.com",
        apiBasePath: "/mounted/api",
        callbackUrl:
          "https://workflows.example.com/mounted/api/integrations/oauth/callback",
        cookiePath: "/mounted/api/integrations/oauth",
        secureCookies: true,
      });
      expect(context.oauth?.metadataDocumentUrl("slack")).toBe(
        "https://workflows.example.com/mounted/api/integrations/oauth/clients/slack"
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("leaves OAuth unavailable without a public origin", async () => {
    const runtime = stubWfGraphRuntime({
      appContext: { apiBasePath: "/mounted/api" },
    });

    try {
      const context = await runtime.runPromise(WfGraphAppContext);
      expect(context.oauth).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });
});
