import { describe, expect, it } from "vitest";
import {
  MAX_REQUEST_BODY_BYTES,
  readCappedText,
} from "#src/backend/lib/http/capped-body";

function post(body: BodyInit | null, headers?: HeadersInit): Request {
  return new Request("http://localhost/hook", {
    method: "POST",
    body,
    ...(headers ? { headers } : {}),
  });
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

  it("accepts a body exactly at the limit", async () => {
    const result = await readCappedText(chunked(["abcde", "fgh"]), 8);
    expect(result).toEqual({ ok: true, text: "abcdefgh" });
  });
});
