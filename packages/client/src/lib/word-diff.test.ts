import { describe, expect, it } from "vitest";
import {
  diffText,
  leadingTokens,
  sidePieces,
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
  it("marks the words that changed and keeps the rest shared", () => {
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
      { kind: "removed", tokens: ["on", " ", "Monday"] },
      { kind: "added", tokens: ["tomorrow"] },
      { kind: "same", tokens: ["."] },
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

describe("sidePieces", () => {
  const words = (count: number, word: string) =>
    Array.from({ length: count }, () => word).join(" ");

  it("shows each side's own changes beside the shared text", () => {
    const runs = diffText("a b", "a c");
    expect(sidePieces(runs, "before", { fold: false })).toEqual([
      { kind: "same", text: "a " },
      { kind: "changed", text: "b" },
    ]);
    expect(sidePieces(runs, "after", { fold: false })).toEqual([
      { kind: "same", text: "a " },
      { kind: "changed", text: "c" },
    ]);
  });

  it("folds long unchanged text and keeps the words next to a change", () => {
    const before = `${words(40, "lead")} old ${words(40, "tail")}`;
    const after = `${words(40, "lead")} new ${words(40, "tail")}`;
    const pieces = sidePieces(diffText(before, after), "after", {
      fold: true,
    });
    expect(pieces.map((piece) => piece.kind)).toEqual([
      "fold",
      "same",
      "changed",
      "same",
      "fold",
    ]);
    expect(pieces[1]).toEqual({ kind: "same", text: `${words(6, "lead")} ` });
    expect(pieces[2]).toEqual({ kind: "changed", text: "new" });
  });

  it("folds the same text on both sides", () => {
    const runs = diffText(
      `${words(40, "lead")} old`,
      `${words(40, "lead")} new`
    );
    const kinds = (side: "before" | "after") =>
      sidePieces(runs, side, { fold: true }).map((piece) => piece.kind);
    expect(kinds("before")).toEqual(["fold", "same", "changed"]);
    expect(kinds("after")).toEqual(["fold", "same", "changed"]);
  });

  it("leaves short unchanged text whole and folds nothing without a change", () => {
    expect(
      sidePieces(diffText("a b old", "a b new"), "before", { fold: true })
    ).toEqual([
      { kind: "same", text: "a b " },
      { kind: "changed", text: "old" },
    ]);
    const long = words(80, "same");
    expect(sidePieces(diffText(long, long), "after", { fold: true })).toEqual([
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
