import { describe, expect, it } from "vitest";
import {
  COMPACT_TITLE_BOX,
  COMPACT_TITLE_LINE_HEIGHT,
  COMPACT_TITLE_MIN_PX,
  fitCompactTitle,
  type MeasureText,
} from "#src/components/flow-elements/compact-card";

/** A monospace measure: every character is 0.5em wide. */
const measure: MeasureText = (text, fontPx) => text.length * fontPx * 0.5;

/** The lines `title` breaks into at `fontPx` when only spaces break it. */
function wrap(title: string, fontPx: number): string[] {
  const lines: string[] = [];
  for (const word of title.split(" ")) {
    const last = lines.at(-1);
    if (
      last !== undefined &&
      measure(`${last} ${word}`, fontPx) <= COMPACT_TITLE_BOX.width
    ) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else {
      lines.push(word);
    }
  }
  return lines;
}

describe("fitCompactTitle", () => {
  it("draws a short title at 24px on at most two lines", () => {
    const fit = fitCompactTitle("Send booking confirmation", measure);

    expect(fit).toEqual({ fontPx: 24, maxLines: 2, hyphenate: false });
    expect(wrap("Send booking confirmation", 24)).toEqual([
      "Send booking",
      "confirmation",
    ]);
  });

  it("steps down to a size where every word fits whole on three lines", () => {
    const title = "Patient still wants their reminders?";
    const fit = fitCompactTitle(title, measure);

    expect(fit.fontPx).toBeLessThan(24);
    expect(fit.fontPx).toBeGreaterThanOrEqual(COMPACT_TITLE_MIN_PX);
    expect(fit.hyphenate).toBe(false);
    const lines = wrap(title, fit.fontPx);
    expect(lines.length).toBeLessThanOrEqual(fit.maxLines);
    expect(
      fit.maxLines * fit.fontPx * COMPACT_TITLE_LINE_HEIGHT
    ).toBeLessThanOrEqual(COMPACT_TITLE_BOX.height);
    for (const line of lines) {
      expect(measure(line, fit.fontPx)).toBeLessThanOrEqual(
        COMPACT_TITLE_BOX.width
      );
    }
  });

  it("keeps the smallest size and ends in an ellipsis when a title needs more than three lines", () => {
    expect(
      fitCompactTitle(
        "Wait for the deposit or a reschedule from the patient before the visit",
        measure
      )
    ).toEqual({ fontPx: COMPACT_TITLE_MIN_PX, maxLines: 3, hyphenate: false });
  });

  it("shrinks a title whose one word is wider than the card until the word fits", () => {
    const fit = fitCompactTitle("Send resynchronizations", measure);

    expect(fit.fontPx).toBeLessThan(COMPACT_TITLE_MIN_PX);
    expect(measure("resynchronizations", fit.fontPx)).toBeLessThanOrEqual(
      COMPACT_TITLE_BOX.width
    );
    expect(fit.hyphenate).toBe(false);
  });

  it("hyphenates a word too wide to fit even at the smallest shrink", () => {
    const fit = fitCompactTitle("Notifyeveryoneatthefrontdesk", measure);

    expect(fit.fontPx).toBe(16);
    expect(fit.hyphenate).toBe(true);
  });

  it("leaves out the largest sizes the page has ruled out, keeping three whole lines", () => {
    expect(fitCompactTitle("Enough time for reminders?", measure, 1)).toEqual({
      fontPx: 23,
      maxLines: 3,
      hyphenate: false,
    });
  });
});
