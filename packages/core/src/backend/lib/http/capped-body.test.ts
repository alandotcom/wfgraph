import { describe, expect, it } from "vitest";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  MAX_REQUEST_BODY_BYTES,
  withCappedBody,
  readCappedText,
} from "#src/backend/lib/http/capped-body";

function post(body: BodyInit | null, headers?: HeadersInit): Request {
  return new Request(
    "http://localhost/hook",
    omitUndefined({
      method: "POST",
      body,
      headers,
    })
  );
}

/** A body arriving in pieces with no `content-length`, the way a chunked send does. */
function chunked(chunks: readonly string[]): Request {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Request("http://localhost/hook", {
    method: "POST",
    body: stream,
    // Node refuses a stream body without it, and it is not in the DOM lib types.
    duplex: "half",
  } as RequestInit);
}

describe("readCappedText", () => {
  it("returns the body byte for byte", async () => {
    const raw = JSON.stringify({ type: "email.delivered", nested: { a: 1 } });
    const result = await readCappedText(post(raw));
    expect(result).toEqual({ ok: true, text: raw });
  });

  it("keeps multi-byte characters intact across chunk boundaries", async () => {
    // The two halves of one UTF-8 sequence arrive in separate chunks, which a
    // per-chunk decode would turn into replacement characters.
    const encoded = new TextEncoder().encode("héllo → wörld");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 2));
        controller.enqueue(encoded.slice(2));
        controller.close();
      },
    });
    const request = new Request("http://localhost/hook", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);

    const result = await readCappedText(request);
    expect(result).toEqual({ ok: true, text: "héllo → wörld" });
  });

  it("reads an empty body as an empty string", async () => {
    const result = await readCappedText(post(null));
    expect(result).toEqual({ ok: true, text: "" });
  });

  it("refuses a declared content-length over the limit without reading", async () => {
    const request = post("hi", {
      "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
    });
    const result = await readCappedText(request);
    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(request.bodyUsed).toBe(false);
  });

  it("refuses a chunked body that grows past the limit", async () => {
    const result = await readCappedText(chunked(["abcde", "fghij"]), 8);
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  // A clone tees the body, and cancelling one branch of a tee settles only
  // once the other branch is cancelled, which an unread clone never is.
  it("refuses an oversized body whose request was cloned", async () => {
    const request = post("x".repeat(16));
    const unreadClone = request.clone();

    const result = await readCappedText(request, 8);

    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(unreadClone.bodyUsed).toBe(false);
  });

  it("accepts a body exactly at the limit", async () => {
    const result = await readCappedText(chunked(["abcde", "fgh"]), 8);
    expect(result).toEqual({ ok: true, text: "abcdefgh" });
  });
});

describe("withCappedBody", () => {
  it("hands back a copy carrying the method, headers, signal and body", async () => {
    const controller = new AbortController();
    const original = new Request("http://localhost/api/rpc/workflow/update", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: '{"json":{}}',
      signal: controller.signal,
    });

    const copy = await withCappedBody(original, 64);

    expect(copy?.method).toBe("PATCH");
    expect(copy?.headers.get("content-type")).toBe("application/json");
    expect(await copy?.text()).toBe('{"json":{}}');
    controller.abort();
    expect(copy?.signal.aborted).toBe(true);
  });

  it("answers null for a body over the limit", async () => {
    expect(await withCappedBody(post("x".repeat(65)), 64)).toBeNull();
  });
});
