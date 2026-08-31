import { describe, expect, it } from "vitest";
import { connectionWebhookUrl } from "#src/extensions/webhook-url";

describe("connectionWebhookUrl", () => {
  it("joins the public origin, API mount, type and Connection id", () => {
    expect(
      connectionWebhookUrl({
        publicUrl: "https://app.example.com",
        apiBasePath: "/api",
        type: "resend",
        connectionId: "conn_1",
      })
    ).toBe("https://app.example.com/api/webhooks/resend/conn_1");
  });

  it("drops a trailing slash on the API mount so the path does not double", () => {
    expect(
      connectionWebhookUrl({
        publicUrl: "https://app.example.com",
        apiBasePath: "/wfgraph/api/",
        type: "resend",
        connectionId: "conn_1",
      })
    ).toBe("https://app.example.com/wfgraph/api/webhooks/resend/conn_1");
  });

  it("encodes the type and Connection id as path segments", () => {
    expect(
      connectionWebhookUrl({
        publicUrl: "https://app.example.com",
        apiBasePath: "/api",
        type: "re/send",
        connectionId: "conn/1",
      })
    ).toBe("https://app.example.com/api/webhooks/re%2Fsend/conn%2F1");
  });
});
