import { describe, expect, it } from "vitest";
import {
  diffText,
  leadingTokens,
  unifiedPieces,
  textTokens,
} from "#src/lib/word-diff";

const NAME =
  "{{@8eeb82e0-cdb5-4a90-941a-25ee25e893dc:Appointment booked.patientName}}";

describe("textTokens", () => {
  it("splits words, spaces and punctuation, and keeps a template reference whole", () => {
    const value = `Hi ${NAME}, see you soon.`;
    const tokens = textTokens(value);
    expect(tokens).toEqual([
      "Hi",
      " ",
      NAME,
      ",",
      " ",
      "see",
      " ",
      "you",
      " ",
      "soon",
      ".",
    ]);
    expect(tokens.join("")).toBe(value);
  });

  it("keeps an apostrophe inside its word", () => {
    expect(textTokens("don't go")).toEqual(["don't", " ", "go"]);
  });
});

describe("diffText", () => {
  it("marks the words that changed, whole, and keeps the rest shared", () => {
    expect(
      diffText(
        `Hi ${NAME}, your visit is on Monday.`,
        `Hi ${NAME}, your visit is tomorrow.`
      )
    ).toEqual([
      {
        kind: "same",
        tokens: [
          "Hi",
          " ",
          NAME,
          ",",
          " ",
          "your",
          " ",
          "visit",
          " ",
          "is",
          " ",
        ],
      },
      // The full stop touches both words, so the replacement takes it in.
      { kind: "removed", tokens: ["on", " ", "Monday", "."] },
      { kind: "added", tokens: ["tomorrow", "."] },
    ]);
  });

  it("marks a changed template reference whole", () => {
    const other = NAME.replace("patientName", "clinicName");
    expect(diffText(`Hi ${NAME}`, `Hi ${other}`)).toEqual([
      { kind: "same", tokens: ["Hi", " "] },
      { kind: "removed", tokens: [NAME] },
      { kind: "added", tokens: [other] },
    ]);
  });

  it("finds words kept between two changes", () => {
    expect(diffText("a b c d", "x b c y")).toEqual([
      { kind: "removed", tokens: ["a"] },
      { kind: "added", tokens: ["x"] },
      { kind: "same", tokens: [" ", "b", " ", "c", " "] },
      { kind: "removed", tokens: ["d"] },
      { kind: "added", tokens: ["y"] },
    ]);
  });

  it("answers one shared run for equal strings", () => {
    expect(diffText("same text", "same text")).toEqual([
      { kind: "same", tokens: ["same", " ", "text"] },
    ]);
  });
});

describe("unifiedPieces", () => {
  const words = (count: number, word: string) =>
    Array.from({ length: count }, () => word).join(" ");

  it("reads as one flow, each removal before the addition that replaces it", () => {
    expect(unifiedPieces(diffText("a b", "a c"), { fold: false })).toEqual([
      { kind: "same", text: "a " },
      { kind: "removed", text: "b" },
      { kind: "gap" },
      { kind: "added", text: "c" },
    ]);
  });

  it("folds long unchanged text and keeps the words next to a change", () => {
    const before = `${words(40, "lead")} old ${words(40, "tail")}`;
    const after = `${words(40, "lead")} new ${words(40, "tail")}`;
    const pieces = unifiedPieces(diffText(before, after), { fold: true });
    expect(pieces.map((piece) => piece.kind)).toEqual([
      "fold",
      "same",
      "removed",
      "gap",
      "added",
      "same",
      "fold",
    ]);
    expect(pieces[1]).toEqual({ kind: "same", text: `${words(6, "lead")} ` });
  });

  it("leaves short unchanged text whole and folds nothing without a change", () => {
    expect(
      unifiedPieces(diffText("a b old", "a b new"), { fold: true })
    ).toEqual([
      { kind: "same", text: "a b " },
      { kind: "removed", text: "old" },
      { kind: "gap" },
      { kind: "added", text: "new" },
    ]);
    const long = words(80, "same");
    expect(unifiedPieces(diffText(long, long), { fold: true })).toEqual([
      { kind: "same", text: long },
    ]);
  });
});

describe("leadingTokens", () => {
  const limits = {
    maxLength: 10,
    maxLines: 2,
    lengthOf: (token: string) => token.length,
  };

  it("stops before the token that would pass the length", () => {
    expect(leadingTokens(textTokens("one two three four"), limits)).toEqual([
      "one",
      " ",
      "two",
      " ",
    ]);
  });

  it("stops before the token that starts a line past the limit", () => {
    expect(leadingTokens(textTokens("a\nb\nc"), limits)).toEqual([
      "a",
      "\n",
      "b",
    ]);
  });

  it("measures a token by the length it reads as", () => {
    expect(
      leadingTokens(textTokens(`${NAME} and more`), {
        ...limits,
        lengthOf: (token) => (token === NAME ? 4 : token.length),
      })
    ).toEqual([NAME, " ", "and", " "]);
  });

  it("keeps at least the first token", () => {
    expect(leadingTokens(["averyveryverylongword"], limits)).toEqual([
      "averyveryverylongword",
    ]);
  });
});

/**
 * The difference as one line, the way the review sheet draws it: removed text
 * between ~~ marks, added text plain, and the gap between them as a space.
 */
function readAsFlow(before: string, after: string): string {
  return unifiedPieces(diffText(before, after), { fold: false })
    .map((piece) => {
      if (piece.kind === "fold") return "…";
      if (piece.kind === "gap") return " ";
      return piece.kind === "removed" ? `~~${piece.text}~~` : piece.text;
    })
    .join("");
}

describe("a difference a reader can parse", () => {
  const STARTS_AT =
    "{{@8eeb82e0-cdb5-4a90-941a-25ee25e893dc:Appointment booked.startsAt}}";

  it("leaves a space between a removed word and the word that replaces it", () => {
    expect(
      readAsFlow(
        `Your appointment is on ${STARTS_AT}.`,
        `Your appointment is tomorrow, ${STARTS_AT}.`
      )
    ).toBe(`Your appointment is ~~on~~ tomorrow, ${STARTS_AT}.`);
  });

  it("joins removed and added words kept apart only by spaces", () => {
    const before = "Reply C to confirm or call us to reschedule";
    const after = "Reply C to confirm or call (555) 555-0142";
    expect(readAsFlow(before, after)).toBe(
      "Reply C to confirm or call ~~us to reschedule~~ (555) 555-0142"
    );
    expect(
      unifiedPieces(diffText(before, after), { fold: false }).map(
        (piece) => piece.kind
      )
    ).toEqual(["same", "removed", "gap", "added"]);
  });

  it("replaces a token with no space in it whole", () => {
    expect(readAsFlow("Deposit of $50 is due", "Deposit of $75 is due")).toBe(
      "Deposit of ~~$50~~ $75 is due"
    );
  });

  it("keeps an insertion where it lands inside a word's punctuation", () => {
    expect(readAsFlow("Reply C to confirm or", "Reply C to confirm, or")).toBe(
      "Reply C to confirm, or"
    );
  });
});
