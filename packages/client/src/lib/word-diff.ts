/**
 * A word-level difference between two strings, for showing what changed inside
 * one stored value. A string splits into words, runs of whitespace and single
 * punctuation marks, and a template reference stays one token, so a changed
 * reference is marked whole and an unchanged one is never split.
 */

import { parseTemplate } from "@wfgraph/shared/graph/node-references";

/** A word, a whitespace run, a punctuation mark, or a whole template reference. */
const WORD_PATTERN =
  /\s+|[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*|[^\s\p{L}\p{N}_]/gu;

/**
 * The largest table the longest-common-subsequence pass fills. A longer pair
 * of differing middles is shown as one removal and one addition.
 */
const MAX_DIFF_CELLS = 250_000;

/** The tokens of `value`, which joined back together reproduce it exactly. */
export function textTokens(value: string): string[] {
  return parseTemplate(value).flatMap((segment) =>
    segment.kind === "token"
      ? [segment.token.raw]
      : (segment.text.match(WORD_PATTERN) ?? [])
  );
}

/**
 * A stretch of tokens that both strings share (`same`), that only the first
 * string holds (`removed`), or that only the second holds (`added`).
 */
export type DiffRun = {
  kind: "same" | "removed" | "added";
  tokens: string[];
};

/** Appends `token` to the last run when it has `kind`, and starts a run otherwise. */
function pushToken(runs: DiffRun[], kind: DiffRun["kind"], token: string) {
  const last = runs.at(-1);
  if (last?.kind === kind) {
    last.tokens.push(token);
  } else {
    runs.push({ kind, tokens: [token] });
  }
}

/**
 * The runs that turn `before` into `after`, in reading order. Inside a changed
 * stretch the removed run comes before the added one. Tokens are compared
 * exactly, so a change of case or spacing is a change.
 */
export function diffText(before: string, after: string): DiffRun[] {
  const left = textTokens(before);
  const right = textTokens(after);
  let prefix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const leftMiddle = left.slice(prefix, left.length - suffix);
  const rightMiddle = right.slice(prefix, right.length - suffix);
  const runs: DiffRun[] = [];
  for (const token of left.slice(0, prefix)) pushToken(runs, "same", token);
  for (const [kind, token] of middleOperations(leftMiddle, rightMiddle)) {
    pushToken(runs, kind, token);
  }
  for (const token of left.slice(left.length - suffix)) {
    pushToken(runs, "same", token);
  }
  return runs;
}

/**
 * The token operations between two middles that share no first or last
 * token, from a longest common subsequence. `lengths[i * width + j]` holds the
 * length of the longest common subsequence of `left` from `i` and `right` from
 * `j`.
 */
function middleOperations(
  left: readonly string[],
  right: readonly string[]
): Array<[DiffRun["kind"], string]> {
  if (left.length * right.length > MAX_DIFF_CELLS) {
    return [
      ...left.map((token): [DiffRun["kind"], string] => ["removed", token]),
      ...right.map((token): [DiffRun["kind"], string] => ["added", token]),
    ];
  }
  const width = right.length + 1;
  const lengths = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        left[i] === right[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              lengths[(i + 1) * width + j] ?? 0,
              lengths[i * width + j + 1] ?? 0
            );
    }
  }
  const operations: Array<[DiffRun["kind"], string]> = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const leftToken = left[i] ?? "";
    const rightToken = right[j] ?? "";
    if (leftToken === rightToken) {
      operations.push(["same", leftToken]);
      i += 1;
      j += 1;
    } else if (
      (lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)
    ) {
      operations.push(["removed", leftToken]);
      i += 1;
    } else {
      operations.push(["added", rightToken]);
      j += 1;
    }
  }
  for (const token of left.slice(i)) operations.push(["removed", token]);
  for (const token of right.slice(j)) operations.push(["added", token]);
  return operations;
}

/**
 * One piece of a side as shown: text both strings share, text this side alone
 * holds, or a fold standing for unchanged text left out.
 */
export type ShownPiece =
  | { kind: "same" | "changed"; text: string }
  | { kind: "fold" };

/** How many unchanged tokens stay in view on each side of a change. */
const FOLD_CONTEXT = 12;
/** A fold must leave out at least this many tokens, or the text stays whole. */
const MIN_FOLDED = 6;

/**
 * The pieces one side of `runs` shows. `before` shows the shared runs and the
 * removed ones, and `after` the shared runs and the added ones. With `fold`, a
 * shared run keeps `FOLD_CONTEXT` tokens next to each change and the rest of it
 * becomes one fold, so both sides fold the same text. A comparison with no
 * change folds nothing.
 */
export function sidePieces(
  runs: readonly DiffRun[],
  side: "before" | "after",
  options: { fold: boolean }
): ShownPiece[] {
  const own = side === "before" ? "removed" : "added";
  const changed = runs.map((run) => run.kind !== "same");
  const anyChange = changed.includes(true);
  return runs.flatMap((run, index): ShownPiece[] => {
    if (run.kind === own)
      return [{ kind: "changed", text: run.tokens.join("") }];
    if (run.kind !== "same") return [];
    const text = run.tokens.join("");
    if (!options.fold || !anyChange) return [{ kind: "same", text }];
    const keepStart = changed.slice(0, index).includes(true) ? FOLD_CONTEXT : 0;
    const keepEnd = changed.slice(index + 1).includes(true) ? FOLD_CONTEXT : 0;
    if (run.tokens.length - keepStart - keepEnd < MIN_FOLDED) {
      return [{ kind: "same", text }];
    }
    const start = run.tokens.slice(0, keepStart).join("");
    const end = run.tokens.slice(run.tokens.length - keepEnd).join("");
    return [
      ...(start === "" ? [] : [{ kind: "same" as const, text: start }]),
      { kind: "fold" as const },
      ...(end === "" ? [] : [{ kind: "same" as const, text: end }]),
    ];
  });
}

/**
 * The opening tokens of `tokens`, ending before the one that would take the
 * text past `maxLength` characters or onto line `maxLines + 1`, as measured by
 * `lengthOf`. Holds at least one token, and every token when they all fit.
 */
export function leadingTokens(
  tokens: readonly string[],
  limits: {
    maxLength: number;
    maxLines: number;
    lengthOf: (token: string) => number;
  }
): readonly string[] {
  let length = 0;
  let lines = 1;
  for (const [index, token] of tokens.entries()) {
    length += limits.lengthOf(token);
    lines += token.split("\n").length - 1;
    if (index > 0 && (length > limits.maxLength || lines > limits.maxLines)) {
      return tokens.slice(0, index);
    }
  }
  return tokens;
}
