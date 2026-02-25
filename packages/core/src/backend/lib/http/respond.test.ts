import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { failure, success } from "@/backend/lib/service-result";
import { respond } from "./respond";

describe("respond", () => {
  it("returns 200 with success payload", async () => {
    const app = new Hono();
    app.get("/", (c) => respond(c, success({ visibility: "public" })));

    const response = await app.request("http://localhost/");
    const payload = (await response.json()) as { visibility?: string };

    expect(response.status).toBe(200);
    expect(payload.visibility).toBe("public");
  });

  it("returns service failure status and body", async () => {
    const app = new Hono();
    app.get("/", (c) =>
      respond(c, failure(409, { error: 'Workflow name "Dup" already exists' }))
    );

    const response = await app.request("http://localhost/");
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(409);
    expect(payload.error).toBe('Workflow name "Dup" already exists');
  });
});
