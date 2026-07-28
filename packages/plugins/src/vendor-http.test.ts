import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { parsePayload, requestVendor } from "@/vendor-http";

const realFetch = globalThis.fetch;
let requests: Request[] = [];

function stubFetch(
  respond: (request: Request) => Response | Promise<Response>
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(respond(request));
  }) as typeof fetch;
}

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const request = {
  url: "https://vendor.example/things",
  method: "POST",
  headers: { authorization: "Bearer k" },
};

describe("requestVendor", () => {
  it("passes the method, headers, and body through", async () => {
    stubFetch(() => Response.json({ id: "1" }));

    await requestVendor({ ...request, body: "hello" });

    const sent = requests[0];
    expect(sent?.url).toBe("https://vendor.example/things");
    expect(sent?.method).toBe("POST");
    expect(sent?.headers.get("authorization")).toBe("Bearer k");
    expect(await sent?.text()).toBe("hello");
  });

  it("reports the status and the parsed body of an answer", async () => {
    stubFetch(() => Response.json({ id: "1" }, { status: 201 }));

    expect(await requestVendor(request)).toEqual({
      kind: "answered",
      status: 201,
      ok: true,
      payload: { id: "1" },
    });
  });

  it("keeps a failure status as an answer rather than an error", async () => {
    stubFetch(() => Response.json({ message: "nope" }, { status: 422 }));

    expect(await requestVendor(request)).toEqual({
      kind: "answered",
      status: 422,
      ok: false,
      payload: { message: "nope" },
    });
  });

  // A 204, an empty body, and HTML from a proxy in front of the vendor all end
  // up here. The status is then the whole story.
  it("answers with no payload when there is no JSON body", async () => {
    for (const response of [
      new Response(null, { status: 204 }),
      new Response("", { status: 200 }),
      new Response("<html>gateway</html>", { status: 502 }),
    ]) {
      stubFetch(() => response);
      const result = await requestVendor(request);
      expect(result.kind).toBe("answered");
      expect(result.kind === "answered" && result.payload).toBeUndefined();
    }
  });

  // The distinction that matters: nothing answered, so there is no status to
  // report and no point retrying against a status code.
  it("reports a request that never arrived", async () => {
    stubFetch(() => Promise.reject(new Error("ECONNREFUSED")));

    expect(await requestVendor(request)).toEqual({
      kind: "unreachable",
      message: "ECONNREFUSED",
    });
  });

  it("carries a non-Error rejection through as text", async () => {
    stubFetch(() => Promise.reject("timeout"));

    expect(await requestVendor(request)).toEqual({
      kind: "unreachable",
      message: "timeout",
    });
  });
});

describe("parsePayload", () => {
  const schema = z.object({ id: z.string() });

  it("returns the parsed value when the payload matches", () => {
    expect(parsePayload({ id: "1", extra: true }, schema)).toEqual({ id: "1" });
  });

  it("returns undefined for a payload of the wrong shape", () => {
    expect(parsePayload({ id: 1 }, schema)).toBeUndefined();
    expect(parsePayload(["1"], schema)).toBeUndefined();
    expect(parsePayload("1", schema)).toBeUndefined();
    expect(parsePayload(undefined, schema)).toBeUndefined();
  });
});
