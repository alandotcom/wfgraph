/**
 * The Canvas Reveal width a person chose, kept in one cookie across reloads.
 * A value that is not a whole number of pixels at or above the minimum reads
 * as absent, so Reveal uses its default width. The canvas clamps a remembered
 * width every time it reads one.
 */

import { atom } from "jotai";
import { Option, Schema } from "effect";
import { readCookie, writeCookie } from "#src/lib/preference-cookies";
import { REVEAL_MIN_WIDTH } from "./reveal-geometry";
import {
  revealKeyResizeInProgressAtom,
  revealResizeSequenceAtom,
} from "./reveal-requests";

const REVEAL_WIDTH_COOKIE = "canvas-reveal-widths";

/** The cookie's JSON object, with its width checked independently. */
const cookieObject = Schema.fromJsonString(
  Schema.Struct({ width: Schema.optionalKey(Schema.Unknown) })
);
const decodeCookieObject = Schema.decodeUnknownOption(cookieObject);
const decodeWidth = Schema.decodeUnknownOption(
  Schema.Finite.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(REVEAL_MIN_WIDTH)
  )
);

/**
 * The remembered width a `canvas-reveal-widths` cookie value holds. An absent,
 * malformed, or legacy family-keyed value reads as no remembered width.
 */
export function readRememberedRevealWidth(
  cookie: string | undefined
): number | undefined {
  if (cookie === undefined) {
    return undefined;
  }
  let json: string;
  try {
    json = decodeURIComponent(cookie);
  } catch {
    return undefined;
  }
  const stored = Option.getOrUndefined(decodeCookieObject(json));
  return stored === undefined
    ? undefined
    : Option.getOrUndefined(decodeWidth(stored.width));
}

/** The cookie value holding `width`, or an empty preference when absent. */
export function rememberedRevealWidthCookie(
  width: number | undefined
): string {
  return encodeURIComponent(JSON.stringify(width === undefined ? {} : { width }));
}

const rememberedRevealWidthStateAtom = atom<number | undefined>(
  readRememberedRevealWidth(readCookie(REVEAL_WIDTH_COOKIE))
);

/** The width a person chose, including one a resize in progress shows. */
export const rememberedRevealWidthAtom = atom((get) =>
  get(rememberedRevealWidthStateAtom)
);

/**
 * Show `width` while a drag or key resize is in progress. It writes no cookie
 * and moves no camera; `finishRevealResizeAtom` does both.
 */
export const resizeRevealWidthAtom = atom(
  null,
  (_get, set, width: number) => {
    set(rememberedRevealWidthStateAtom, width);
  }
);

/**
 * Begin a keyboard resize, so the camera records where it stands before any
 * width changes. `finishRevealResizeAtom` ends it.
 */
export const startRevealKeyResizeAtom = atom(null, (_get, set) => {
  set(revealKeyResizeInProgressAtom, true);
});

/**
 * End a resize: keep the width in the cookie and ask the camera to place the
 * subject beside the new width once.
 */
export const finishRevealResizeAtom = atom(null, (get, set) => {
  set(revealKeyResizeInProgressAtom, false);
  writeCookie(
    REVEAL_WIDTH_COOKIE,
    rememberedRevealWidthCookie(get(rememberedRevealWidthStateAtom))
  );
  set(revealResizeSequenceAtom, get(revealResizeSequenceAtom) + 1);
});

/** Forget the chosen width, use the default, and end the resize. */
export const resetRevealWidthAtom = atom(null, (_get, set) => {
  set(rememberedRevealWidthStateAtom, undefined);
  set(finishRevealResizeAtom);
});
