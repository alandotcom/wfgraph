/**
 * Read a request body with a hard byte ceiling.
 *
 * Webhook routes bypass host `auth`, so an unauthenticated client reaches them
 * before anything has looked up the Connection. Reading such a body straight
 * into memory lets a sender decide how much the process allocates, so webhook
 * routes read through this function.
 *
 * The bytes come back decoded as UTF-8 and byte-for-byte as they arrived, which
 * is what Svix and every other HMAC scheme needs: re-serializing a parsed body
 * changes the signature.
 */

/**
 * The ceiling every capped route uses. Webhook providers send bodies far under
 * this; raise it only for a webhook that legitimately carries more, such as one
 * delivering attachments inline.
 */
export const MAX_REQUEST_BODY_BYTES = 1_048_576;

/**
 * The ceiling for an authenticated operator request: RPC, REST and OAuth
 * start. A workflow save carries the whole graph, which for 500 configured
 * action nodes serializes to about half a megabyte, and a build-agent chat
 * carries its message history beside the graph, so this is 8 MiB.
 */
export const OPERATOR_REQUEST_BODY_BYTES = 8 * 1_048_576;

export type CappedBody =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" };

type CappedBytes =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; reason: "too_large" };

const TOO_LARGE = { ok: false, reason: "too_large" } as const;

/** The body as UTF-8 text, refused past `limitBytes`. */
export async function readCappedText(
  request: Request,
  limitBytes: number = MAX_REQUEST_BODY_BYTES
): Promise<CappedBody> {
  const read = await readCappedBytes(request, limitBytes);
  return read.ok
    ? { ok: true, text: new TextDecoder().decode(read.bytes) }
    : TOO_LARGE;
}

/**
 * A copy of `request` whose body is already read and held to `limitBytes`,
 * for a handler that reads the body itself, or `null` past the limit. A
 * request with no body comes back as it is.
 */
export async function withCappedBody(
  request: Request,
  limitBytes: number
): Promise<Request | null> {
  if (request.body === null) {
    return request;
  }
  const read = await readCappedBytes(request, limitBytes);
  // Built from the request's parts rather than from the request itself: the
  // Node adapter hands over its own lightweight Request class, which the
  // global constructor does not accept as an input.
  return read.ok
    ? new Request(request.url, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        body: read.bytes,
      })
    : null;
}

/**
 * `content-length` is a claim, not a guarantee, and a chunked request sends
 * none at all, so it is a cheap first refusal rather than the check. The count
 * kept while reading is what actually holds the sender to the limit.
 */
async function readCappedBytes(
  request: Request,
  limitBytes: number
): Promise<CappedBytes> {
  // A missing or malformed header reads as 0 or NaN, and neither compares above
  // the limit, so both fall through to the count kept while reading.
  if (Number(request.headers.get("content-length")) > limitBytes) {
    return TOO_LARGE;
  }

  const body = request.body;
  if (!body) {
    return { ok: true, bytes: new Uint8Array() };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overLimit = false;

  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- a stream arrives one chunk at a time.
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limitBytes) {
      overLimit = true;
      break;
    }
    chunks.push(value);
  }

  if (overLimit) {
    // Cancelling tells the sender to stop rather than leaving it streaming into
    // a reader nothing is draining. It is not awaited: a request that was
    // cloned, as host authentication clones every operator request, reads one
    // branch of a tee, and that branch's cancel settles only once every other
    // branch is cancelled too.
    reader.cancel().catch(() => undefined);
    return TOO_LARGE;
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, bytes: joined };
}
