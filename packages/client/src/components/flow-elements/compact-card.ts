/**
 * The sizes of a compact card, in canvas pixels, and how large its title draws
 * so that it breaks only between words. `fitCompactTitle` is pure over a text
 * measure; `measureCompactTitle` measures with the card's own font, and
 * estimates where a page has no 2D canvas, as in a test.
 */

/**
 * The size of a compact card's step number and its marks: the issue badge,
 * the disabled mark and the run status. It draws at 11.7px on screen at zoom
 * 0.53, where a 1512 by 982 window fits the seeded 16-step workflow.
 */
export const COMPACT_MARK_PX = 22;

/** The box a compact card gives its title, in canvas pixels. */
export const COMPACT_TITLE_BOX = { width: 164, height: 76 } as const;

/** A compact title's line height, as a multiple of its type size. */
export const COMPACT_TITLE_LINE_HEIGHT = 1.1;

/**
 * The smallest size a compact title draws at unless one word is wider than
 * the card. It draws at 11.1px on screen at zoom 0.53.
 */
export const COMPACT_TITLE_MIN_PX = 21;

/** The type sizes a compact title tries, largest first. */
const TITLE_SIZES = [24, 23, 22, COMPACT_TITLE_MIN_PX] as const;

/** The smallest size a title shrinks to so one long word fits on a line. */
const LONG_WORD_FLOOR_PX = 16;

export type CompactTitleFit = {
  /** The type size, in canvas pixels. */
  fontPx: number;
  /** The most lines the title draws; anything past them ends in an ellipsis. */
  maxLines: number;
  /** Whether a word wider than the box breaks with a hyphen. */
  hyphenate: boolean;
};

/** The width of `text` set in the title's font at `fontPx`, in canvas pixels. */
export type MeasureText = (text: string, fontPx: number) => number;

function linesAt(fontPx: number): number {
  return Math.floor(
    COMPACT_TITLE_BOX.height / (fontPx * COMPACT_TITLE_LINE_HEIGHT)
  );
}

/** How many lines `words` take at `fontPx` when lines break between words. */
function lineCount(
  words: readonly string[],
  fontPx: number,
  measure: MeasureText
): number {
  let lines = 0;
  let line = "";
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (line !== "" && measure(candidate, fontPx) > COMPACT_TITLE_BOX.width) {
      lines += 1;
      line = word;
    } else {
      line = candidate;
    }
  }
  return line === "" ? lines : lines + 1;
}

/**
 * The largest size at which every word of `title` fits on a line and the
 * whole title fits the box, breaking only between words: 24px on two lines,
 * or down to 21px on three. Only a title that does not fit three lines at
 * 21px ends in an ellipsis. A word wider than the box at 21px shrinks the
 * title until it fits, and below 16px it breaks with a hyphen instead.
 *
 * `skipSizes` leaves out that many of the largest sizes, for a title the page
 * laid out on more lines than the measure predicted.
 */
export function fitCompactTitle(
  title: string,
  measure: MeasureText,
  skipSizes = 0
): CompactTitleFit {
  const words = title.split(/\s+/).filter((word) => word !== "");
  const widestAt = (fontPx: number) =>
    Math.max(0, ...words.map((word) => measure(word, fontPx)));
  for (const fontPx of TITLE_SIZES.slice(skipSizes)) {
    if (
      widestAt(fontPx) <= COMPACT_TITLE_BOX.width &&
      lineCount(words, fontPx, measure) <= linesAt(fontPx)
    ) {
      return { fontPx, maxLines: linesAt(fontPx), hyphenate: false };
    }
  }
  const smallest = TITLE_SIZES[TITLE_SIZES.length - 1];
  const widest = widestAt(smallest);
  if (widest <= COMPACT_TITLE_BOX.width) {
    return { fontPx: smallest, maxLines: linesAt(smallest), hyphenate: false };
  }
  const shrunk = Math.floor((smallest * COMPACT_TITLE_BOX.width) / widest);
  const fontPx = Math.max(LONG_WORD_FLOOR_PX, shrunk);
  return {
    fontPx,
    maxLines: linesAt(fontPx),
    hyphenate: shrunk < LONG_WORD_FLOOR_PX,
  };
}

/** Whether a later size in the list remains after skipping `skipSizes`. */
export function hasSmallerTitleSize(skipSizes: number): boolean {
  return skipSizes < TITLE_SIZES.length - 1;
}

let context: CanvasRenderingContext2D | null | undefined;
let fontFamily = "sans-serif";

/**
 * The first family of the page's font stack, then `sans-serif`. A canvas
 * refuses a whole font string holding a family it cannot parse, such as
 * `ui-sans-serif`, and keeps measuring in its 10px default.
 */
function canvasFontFamily(stack: string): string {
  const first = stack.split(",")[0]?.trim();
  return first ? `${first}, sans-serif` : "sans-serif";
}

/**
 * Measures text in the canvas cards' semibold sans, read from the page's own
 * font stack, with 3% added for the difference between a canvas measure and
 * the page's own line breaking. Without a 2D canvas, or when the canvas
 * refuses the font, it estimates 0.62em a character, which is wider than the
 * font's average so an estimate errs toward a smaller size.
 */
export const measureCompactTitle: MeasureText = (text, fontPx) => {
  if (context === undefined) {
    context =
      typeof document === "undefined"
        ? null
        : document.createElement("canvas").getContext("2d");
    if (typeof document !== "undefined") {
      fontFamily = canvasFontFamily(getComputedStyle(document.body).fontFamily);
    }
  }
  if (context === null) {
    return text.length * fontPx * 0.62;
  }
  context.font = `600 ${fontPx}px ${fontFamily}`;
  if (!context.font.includes(`${fontPx}px`)) {
    return text.length * fontPx * 0.62;
  }
  return context.measureText(text).width * 1.03;
};
