import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApiApp,
  machineRoutes,
  requestLogPath,
} from "#src/backend/api-app";
import type { IntegrationWebhook } from "#src/backend/extensions/integration-webhook";
import { SignatureRejected } from "#src/backend/extensions/integration-webhook";
import type { InngestClient } from "#src/backend/lib/effect/inngest-client";
import { MAX_REQUEST_BODY_BYTES } from "#src/backend/lib/http/capped-body";
import {
  defineWfGraphAuth,
  resolveAuth,
} from "#src/backend/lib/http/authorize";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import type { DecryptedIntegration } from "#src/backend/services/integrations/repo";
import { receiveWebhook } from "#src/backend/services/integrations/webhook-intake";
import {
  emptyExtensionCatalog,
  type IntegrationMetadata,
} from "@wfgraph/shared/extensions/catalog";

const connection: DecryptedIntegration = {
  id: "conn_1",
  name: "Resend prod",
  type: "resend",
  config: { RESEND_WEBHOOK_SECRET: "whsec_test" },
  configRevision: 0,
  isManaged: false,
  refreshState: "idle",
  refreshClaimId: null,
  refreshClaimedAt: null,
  createdAt: new Date("2026-08-30T00:00:00.000Z"),
  updatedAt: new Date("2026-08-30T00:00:00.000Z"),
};

const resendMeta: IntegrationMetadata = {
  type: "resend",
  label: "Resend",
  description: "Transactional email",
  hasTest: false,
  hasWebhook: true,
  credentialFields: {
    RESEND_WEBHOOK_SECRET: {
      label: "Webhook Signing Secret",
      type: "password",
    },
  },
};

const envelope = {
  type: "email.delivered",
  created_at: "2026-02-22T23:41:12.126Z",
  data: { email_id: "em_1" },
};

function webhook(
  overrides: Partial<IntegrationWebhook> = {}
): IntegrationWebhook {
  return {
    source: "resend/webhook",
    verify: () => Effect.void,
    receive: () => ({
      data: envelope,
      id: "msg_1",
    }),
    ...overrides,
  };
}

function runtimeFor(
  input: {
    webhook?: IntegrationWebhook | undefined;
    send?: InngestClient["Service"]["sendCatalogEvent"] | undefined;
  } = {}
) {
  const sendCatalogEvent = vi.fn<InngestClient["Service"]["sendCatalogEvent"]>(
    input.send ?? (() => Effect.void)
  );
  return {
    sendCatalogEvent,
    runtime: stubWfGraphRuntime({
      extensions: {
        catalog: {
          ...emptyExtensionCatalog,
          integrations: [resendMeta],
        },
        webhookFor: (type) =>
          type === "resend" ? (input.webhook ?? webhook()) : undefined,
      },
      integrationRepo: {
        findById: (id) =>
          Effect.succeed(id === connection.id ? connection : null),
      },
      inngestClient: { sendCatalogEvent },
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("receiveWebhook", () => {
  it("answers not found for an unknown type", async () => {
    const { runtime } = runtimeFor();
    try {
      const failure = await runtime.runPromise(
        receiveWebhook({
          type: "slack",
          connectionId: connection.id,
          rawBody: "{}",
          headers: new Headers(),
        }).pipe(Effect.flip)
      );
      expect(failure._tag).toBe("NotFound");
    } finally {
      await runtime.dispose();
    }
  });

  it("answers not found for a Connection of the wrong type", async () => {
    const { runtime } = runtimeFor();
    try {
      const failure = await runtime.runPromise(
        receiveWebhook({
          type: "resend",
          connectionId: "other",
          rawBody: "{}",
          headers: new Headers(),
        }).pipe(Effect.flip)
      );
      expect(failure._tag).toBe("NotFound");
    } finally {
      await runtime.dispose();
    }
  });

  it("answers unauthorized when verify refuses the signature", async () => {
    const { runtime } = runtimeFor({
      webhook: webhook({
        verify: () =>
          Effect.fail(new SignatureRejected({ error: "Bad signature" })),
      }),
    });
    try {
      const failure = await runtime.runPromise(
        receiveWebhook({
          type: "resend",
          connectionId: connection.id,
          rawBody: JSON.stringify(envelope),
          headers: new Headers(),
        }).pipe(Effect.flip)
      );
      expect(failure._tag).toBe("Unauthorized");
      expect(failure.error).toBe("Bad signature");
    } finally {
      await runtime.dispose();
    }
  });

  it("answers 200 and sends nothing when receive ignores the type", async () => {
    const { runtime, sendCatalogEvent } = runtimeFor({
      webhook: webhook({ receive: () => undefined }),
    });
    try {
      const result = await runtime.runPromise(
        receiveWebhook({
          type: "resend",
          connectionId: connection.id,
          rawBody: JSON.stringify(envelope),
          headers: new Headers(),
        })
      );
      expect(result).toEqual({ kind: "ignored" });
      expect(sendCatalogEvent).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it("sends the catalog Event with connectionId and the raw-body id", async () => {
    const seen: { rawBody?: string } = {};
    const { runtime, sendCatalogEvent } = runtimeFor({
      webhook: webhook({
        verify: ({ rawBody }) => {
          seen.rawBody = rawBody;
          return Effect.void;
        },
      }),
    });
    const rawBody = JSON.stringify(envelope);
    try {
      const result = await runtime.runPromise(
        receiveWebhook({
          type: "resend",
          connectionId: connection.id,
          rawBody,
          headers: new Headers({ "svix-id": "msg_1" }),
        })
      );
      expect(result).toEqual({ kind: "sent", event: "resend/webhook" });
      expect(seen.rawBody).toBe(rawBody);
      expect(sendCatalogEvent).toHaveBeenCalledWith({
        name: "resend/webhook",
        data: envelope,
        connectionId: connection.id,
        id: "msg_1",
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("refuses a body that is not a JSON object", async () => {
    const { runtime } = runtimeFor();
    try {
      const failure = await runtime.runPromise(
        receiveWebhook({
          type: "resend",
          connectionId: connection.id,
          rawBody: "[1]",
          headers: new Headers(),
        }).pipe(Effect.flip)
      );
      expect(failure._tag).toBe("InvalidInput");
    } finally {
      await runtime.dispose();
    }
  });
});

describe("webhook HTTP route", () => {
  it("is a machine route even when Inngest HTTP serve is off", () => {
    expect(machineRoutes({ serveInngest: false })).toContain(
      "/webhooks/:type/:connectionId"
    );
  });

  it("redacts the Connection id from request log paths", () => {
    expect(requestLogPath("/wfgraph/api/webhooks/resend/conn_1")).toBe(
      "/wfgraph/api/webhooks/resend/:connectionId"
    );
  });

  it("answers without host auth", async () => {
    const { runtime, sendCatalogEvent } = runtimeFor();
    const app = createApiApp({
      basePath: "/api",
      auth: resolveAuth(defineWfGraphAuth(() => null)),
      runtime,
    });

    try {
      const response = await app.fetch(
        new Request("http://localhost/api/webhooks/resend/conn_1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(envelope),
        })
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(sendCatalogEvent).toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it("answers 401 for a refused signature", async () => {
    const { runtime } = runtimeFor({
      webhook: webhook({
        verify: () =>
          Effect.fail(new SignatureRejected({ error: "Bad signature" })),
      }),
    });
    const app = createApiApp({
      basePath: "/api",
      auth: resolveAuth(defineWfGraphAuth(() => null)),
      runtime,
    });

    try {
      const response = await app.fetch(
        new Request("http://localhost/api/webhooks/resend/conn_1", {
          method: "POST",
          body: JSON.stringify(envelope),
        })
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Bad signature" });
    } finally {
      await runtime.dispose();
    }
  });

  it("answers 413 for a body over the ceiling, before the Connection is read", async () => {
    let lookups = 0;
    const sendCatalogEvent = vi.fn<
      InngestClient["Service"]["sendCatalogEvent"]
    >(() => Effect.void);
    await using runtime = stubWfGraphRuntime({
      extensions: {
        catalog: { ...emptyExtensionCatalog, integrations: [resendMeta] },
        webhookFor: (type) => (type === "resend" ? webhook() : undefined),
      },
      integrationRepo: {
        findById: (id) =>
          Effect.sync(() => {
            lookups += 1;
            return id === connection.id ? connection : null;
          }),
      },
      inngestClient: { sendCatalogEvent },
    });
    const app = createApiApp({
      basePath: "/api",
      auth: resolveAuth(defineWfGraphAuth(() => null)),
      runtime,
    });

    const response = await app.fetch(
      new Request("http://localhost/api/webhooks/resend/conn_1", {
        method: "POST",
        body: "x".repeat(MAX_REQUEST_BODY_BYTES + 1),
      })
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Request body is too large",
    });
    expect(lookups).toBe(0);
    expect(sendCatalogEvent).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown Connection", async () => {
    const { runtime } = runtimeFor();
    const app = createApiApp({
      basePath: "/api",
      auth: resolveAuth(defineWfGraphAuth(() => null)),
      runtime,
    });

    try {
      const response = await app.fetch(
        new Request("http://localhost/api/webhooks/resend/missing", {
          method: "POST",
          body: JSON.stringify(envelope),
        })
      );
      expect(response.status).toBe(404);
    } finally {
      await runtime.dispose();
    }
  });
});
