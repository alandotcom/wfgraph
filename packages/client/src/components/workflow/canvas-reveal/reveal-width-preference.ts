/**
 * The Canvas Reveal widths a person chose, kept in one cookie across reloads.
 * A value the cookie holds that is not a whole number of pixels at or above
 * its key's minimum reads as absent, so that key uses its default width. The
 * legacy `browse` key is read as `compact`. The canvas clamps each remembered
 * width every time it reads one.
 */

import { omit } from "es-toolkit/object";
import { atom } from "jotai";
import { Option, Schema } from "effect";
import { readCookie, writeCookie } from "#src/lib/preference-cookies";
import {
  REVEAL_MIN_WIDTH,
  type RememberedRevealWidths,
  type RevealWidthKey,
} from "./reveal-geometry";
import {
  revealKeyResizeInProgressAtom,
  revealResizeSequenceAtom,
} from "./reveal-requests";

const REVEAL_WIDTHS_COOKIE = "canvas-reveal-widths";

const WIDTH_KEYS: readonly RevealWidthKey[] = ["compact", "standard", "wide"];

/** The cookie's JSON object, with each key's value checked on its own. */
const cookieObject = Schema.fromJsonString(
  Schema.Struct({
    browse: Schema.optionalKey(Schema.Unknown),
    compact: Schema.optionalKey(Schema.Unknown),
    standard: Schema.optionalKey(Schema.Unknown),
    wide: Schema.optionalKey(Schema.Unknown),
  })
);
const decodeCookieObject = Schema.decodeUnknownOption(cookieObject);

const decodeWidth: Readonly<
  Record<RevealWidthKey, (input: unknown) => Option.Option<number>>
> = {
  compact: widthDecoder("compact"),
  standard: widthDecoder("standard"),
  wide: widthDecoder("wide"),
};

function widthDecoder(
  key: RevealWidthKey
): (input: unknown) => Option.Option<number> {
  return Schema.decodeUnknownOption(
    Schema.Finite.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(REVEAL_MIN_WIDTH[key])
    )
  );
}

/**
 * The remembered widths a `canvas-reveal-widths` cookie value holds. An absent,
 * malformed, or non-JSON value reads as no remembered widths.
 */
export function readRememberedRevealWidths(
  cookie: string | undefined
): RememberedRevealWidths {
  if (cookie === undefined) {
    return {};
  }
  let json: string;
  try {
    json = decodeURIComponent(cookie);
  } catch {
    return {};
  }
  const stored = Option.getOrUndefined(decodeCookieObject(json));
  if (stored === undefined) {
    return {};
  }
  return Object.fromEntries(
    WIDTH_KEYS.flatMap((key) => {
      const value =
        key === "compact" && stored.compact === undefined
          ? stored.browse
          : stored[key];
      return Option.match(decodeWidth[key](value), {
        onNone: () => [],
        onSome: (width) => [[key, width] as const],
      });
    })
  );
}

/** The cookie value holding `widths`. */
export function rememberedRevealWidthsCookie(
  widths: RememberedRevealWidths
): string {
  return encodeURIComponent(JSON.stringify(widths));
}

const rememberedRevealWidthsStateAtom = atom<RememberedRevealWidths>(
  readRememberedRevealWidths(readCookie(REVEAL_WIDTHS_COOKIE))
);

/** The widths a person chose, including one a resize in progress shows. */
export const rememberedRevealWidthsAtom = atom((get) =>
  get(rememberedRevealWidthsStateAtom)
);

/**
 * Show `width` for `key` while a drag or key resize is in progress. It writes
 * no cookie and moves no camera; `finishRevealResizeAtom` does both.
 */
export const resizeRevealWidthAtom = atom(
  null,
  (get, set, input: { key: RevealWidthKey; width: number }) => {
    set(rememberedRevealWidthsStateAtom, {
      ...get(rememberedRevealWidthsStateAtom),
      [input.key]: input.width,
    });
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
 * End a resize: keep the widths in the cookie and ask the camera to place the
 * subject beside the new width once.
 */
export const finishRevealResizeAtom = atom(null, (get, set) => {
  set(revealKeyResizeInProgressAtom, false);
  writeCookie(
    REVEAL_WIDTHS_COOKIE,
    rememberedRevealWidthsCookie(get(rememberedRevealWidthsStateAtom))
  );
  set(revealResizeSequenceAtom, get(revealResizeSequenceAtom) + 1);
});

/** Forget the width chosen for `key`, so it uses its default, and end the resize. */
export const resetRevealWidthAtom = atom(
  null,
  (get, set, key: RevealWidthKey) => {
    set(
      rememberedRevealWidthsStateAtom,
      omit(get(rememberedRevealWidthsStateAtom), [key])
    );
    set(finishRevealResizeAtom);
  }
);
