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

export type CappedBody =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" };

const TOO_LARGE: CappedBody = { ok: false, reason: "too_large" };

/**
 * `content-length` is a claim, not a guarantee, and a chunked request sends
 * none at all, so it is a cheap first refusal rather than the check. The count
 * kept while reading is what actually holds the sender to the limit.
 */
export async function readCappedText(
  request: Request,
  limitBytes: number = MAX_REQUEST_BODY_BYTES
): Promise<CappedBody> {
  // A missing or malformed header reads as 0 or NaN, and neither compares above
  // the limit, so both fall through to the count kept while reading.
  if (Number(request.headers.get("content-length")) > limitBytes) {
    return TOO_LARGE;
  }

  const body = request.body;
  if (!body) {
    return { ok: true, text: "" };
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
    // a reader nothing is draining.
    await reader.cancel();
    return TOO_LARGE;
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, text: new TextDecoder().decode(joined) };
}
