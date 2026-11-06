/**
 * Whether an `Authorization` header carries `Bearer <key>` for a shared key.
 * The comparison hashes both sides to one length and compares the digests in
 * constant time, so how long it takes says nothing about how much of the key a
 * sender guessed. The scheme name is matched without regard to case.
 */

import { createHash, timingSafeEqual } from "node:crypto";

const BEARER = /^bearer\s+(\S+)\s*$/i;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function bearerKeyMatches(
  authorization: string | undefined,
  key: string
): boolean {
  const presented = authorization?.match(BEARER)?.[1];
  if (presented === undefined) return false;
  return timingSafeEqual(digest(presented), digest(key));
}
