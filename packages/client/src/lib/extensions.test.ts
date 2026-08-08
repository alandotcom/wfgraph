import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import {
  getExtensionCatalog,
  hydrateExtensionsFromApi,
} from "#src/lib/extensions";
import { clearTestCatalog } from "#src/lib/extensions-test-support";

const served: ExtensionCatalog = {
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      correlationPath: "appointment.id",
      payloadFields: [
        {
          path: "appointment.id",
          description: "Appointment ID",
          type: "string",
        },
      ],
    },
  ],
  actions: [
    {
      id: "twilio/send-sms",
      label: "Send SMS",
      description: "Send an SMS via Twilio",
      category: "Twilio",
      integration: "twilio",
      configFields: [],
      outputFields: [
        { path: "sid", description: "Message SID", type: "string" },
      ],
    },
  ],
  integrations: [
    {
      type: "twilio",
      label: "Twilio",
      description: "Send SMS messages with Twilio",
      credentialFields: {
        TWILIO_AUTH_TOKEN: { label: "Auth Token", type: "password" },
      },
      hasTest: true,
    },
  ],
};

/**
 * The endpoint's whole answer, which is one member: `catalog`. Passing the envelope
 * rather than the document is what the cases below decoding a malformed one need.
 */
function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })
      )
    )
  );
}

beforeEach(async () => {
  await clearTestCatalog();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hydrateExtensionsFromApi", () => {
  it("holds the empty catalog before anything is fetched", () => {
    expect(getExtensionCatalog()).toEqual(emptyExtensionCatalog);
  });

  it("decodes the catalog the server assembled", async () => {
    respondWith({ catalog: served });

    await expect(hydrateExtensionsFromApi()).resolves.toEqual({ ok: true });

    expect(getExtensionCatalog()).toEqual(served);
  });

  it("asks the API path under the mount prefix", async () => {
    respondWith({ catalog: served });

    await hydrateExtensionsFromApi();

    expect(fetch).toHaveBeenCalledWith(
      "/api/extensions",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("reads the surface in one request", async () => {
    respondWith({ catalog: served });

    await hydrateExtensionsFromApi();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getExtensionCatalog()).toEqual(served);
  });

  it("says so when the catalog does not fit the wire schema", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    respondWith({ catalog: { events: [], actions: [] } });

    await expect(hydrateExtensionsFromApi()).resolves.toEqual({
      ok: false,
      reason: "mismatch",
    });

    // The logger hands console.warn a `%c` template plus its CSS arguments, so
    // the assertion reads the template rather than the whole argument list.
    expect(warn.mock.calls[0]?.[0]).toContain("/api/extensions");
    warn.mockRestore();
  });

  // Each of the three names a different thing to tell the person reading the
  // screen, and an empty catalog tells them their host declared nothing.
  it("answers a refused response as a refusal", async () => {
    respondWith({ error: "Not found" }, 404);

    await expect(hydrateExtensionsFromApi()).resolves.toEqual({
      ok: false,
      reason: "refused",
    });
  });

  // Each failure below leaves whatever was decoded last in place, which for a
  // single hydration before render means the editor draws with the surface it has.
  it("keeps the last good catalog when the endpoint refuses", async () => {
    respondWith({ catalog: served });
    await hydrateExtensionsFromApi();

    respondWith({ error: "Not found" }, 404);
    await hydrateExtensionsFromApi();

    expect(getExtensionCatalog()).toEqual(served);
  });

  it("keeps the last good catalog when the document does not fit", async () => {
    respondWith({ catalog: served });
    await hydrateExtensionsFromApi();

    respondWith({ catalog: { events: [], actions: [] } });
    await hydrateExtensionsFromApi();

    expect(getExtensionCatalog()).toEqual(served);
  });

  it("keeps the last good catalog when the answer carries no catalog", async () => {
    respondWith({ catalog: served });
    await hydrateExtensionsFromApi();

    respondWith({ nothing: true });
    await hydrateExtensionsFromApi();

    expect(getExtensionCatalog()).toEqual(served);
  });

  it("answers a fetch that never returns as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline")))
    );

    await expect(hydrateExtensionsFromApi()).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
});
