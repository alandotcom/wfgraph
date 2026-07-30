import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
} from "@rova/shared/extensions/catalog";
import {
  getExtensionCatalog,
  hydrateExtensionsFromApi,
} from "#src/lib/extensions";
import { getRuntimeTriggers } from "#src/lib/runtime-extensions";
import {
  findActionById,
  getIntegration,
  unregisterIntegration,
} from "@rova/shared/plugins/registry";

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
      credentialFields: [
        {
          label: "Auth Token",
          type: "password",
          configKey: "authToken",
          envVar: "TWILIO_AUTH_TOKEN",
        },
      ],
      hasTest: true,
    },
  ],
};

/**
 * The endpoint's whole answer. The catalog arrives beside what the old registries
 * send, and this hydration reads its own member out of it.
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

afterEach(() => {
  unregisterIntegration("twilio");
  vi.unstubAllGlobals();
  // The catalog is module state, so a case that wants an unhydrated one imports
  // the module again rather than reading the one above.
  vi.resetModules();
});

describe("hydrateExtensionsFromApi", () => {
  it("holds the empty catalog before anything is fetched", async () => {
    const fresh = await import("#src/lib/extensions");

    expect(fresh.getExtensionCatalog()).toEqual(emptyExtensionCatalog);
  });

  it("decodes the catalog the server assembled", async () => {
    respondWith({ actions: [], triggers: [], catalog: served });

    await hydrateExtensionsFromApi();

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

  // One endpoint answers both halves, so it is read once. The trigger is the
  // second half, and it arrives only if that half read the same response.
  it("fills both halves of the surface from one request", async () => {
    respondWith({
      actions: [],
      triggers: [
        {
          type: "AppointmentLifecycle",
          label: "Appointment Lifecycle",
          executionType: "event",
        },
      ],
      catalog: served,
    });

    await hydrateExtensionsFromApi();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getExtensionCatalog()).toEqual(served);
    expect(getRuntimeTriggers().map((trigger) => trigger.type)).toEqual([
      "AppointmentLifecycle",
    ]);
  });

  it("says so when the catalog does not fit the wire schema", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    respondWith({ catalog: { events: [], actions: [] } });

    await hydrateExtensionsFromApi();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("/api/extensions")
    );
    warn.mockRestore();
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

    respondWith({ actions: [], triggers: [] });
    await hydrateExtensionsFromApi();

    expect(getExtensionCatalog()).toEqual(served);
  });

  it("survives a fetch that never answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline")))
    );

    await expect(hydrateExtensionsFromApi()).resolves.toBeUndefined();
  });
});

/**
 * The catalog is the browser's one producer of integration metadata, and every
 * reader in the editor still asks the plugin registry, so hydration fills it. B4
 * points those readers at the catalog and deletes both halves of this.
 */
describe("the plugin registry the catalog fills", () => {
  it("gives the integrations dialog its credential form", async () => {
    respondWith({ catalog: served });

    await hydrateExtensionsFromApi();

    expect(getIntegration("twilio")).toEqual(
      expect.objectContaining({
        type: "twilio",
        label: "Twilio",
        formFields: [
          {
            // The registry keys its input by an id and the catalog carries none,
            // because a credential field has one name and it is the config key.
            id: "authToken",
            label: "Auth Token",
            type: "password",
            configKey: "authToken",
            envVar: "TWILIO_AUTH_TOKEN",
          },
        ],
      })
    );
  });

  // The slug is read back off the action id rather than sliced by length, and the
  // grouping is by the integration each action names.
  it("gives the action selector its actions, keyed by id", async () => {
    respondWith({ catalog: served });

    await hydrateExtensionsFromApi();

    expect(findActionById("twilio/send-sms")).toEqual(
      expect.objectContaining({
        id: "twilio/send-sms",
        slug: "send-sms",
        label: "Send SMS",
        integration: "twilio",
        outputFields: [
          { path: "sid", description: "Message SID", type: "string" },
        ],
      })
    );
  });

  it("leaves an integration nothing declared out of the registry", async () => {
    respondWith({ catalog: served });

    await hydrateExtensionsFromApi();

    expect(getIntegration("resend")).toBeUndefined();
  });
});
