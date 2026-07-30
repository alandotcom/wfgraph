import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCatalog } from "@rova/shared/extensions/catalog";
import {
  getExtensionCatalog,
  hydrateExtensionsFromApi,
} from "#src/lib/extensions";
import { getRuntimeTriggers } from "#src/lib/runtime-extensions";

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
      credentialFields: [],
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
  vi.unstubAllGlobals();
});

describe("hydrateExtensionsFromApi", () => {
  it("holds the empty catalog before anything is fetched", () => {
    expect(getExtensionCatalog().actions).toEqual([]);
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
