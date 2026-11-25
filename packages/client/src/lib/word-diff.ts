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
 * The runs that turn `before` into `after`, in reading order, shaped for a
 * reader as `readableRuns` describes. Inside a changed stretch the removed run
 * comes before the added one. Tokens are compared exactly, so a change of case
 * or spacing is a change.
 */
export function diffText(before: string, after: string): DiffRun[] {
  return readableRuns(tokenRuns(before, after));
}

/** The token-level runs that turn `before` into `after`. */
function tokenRuns(before: string, after: string): DiffRun[] {
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

function isWhitespace(token: string): boolean {
  return /^\s+$/u.test(token);
}

/**
 * One stretch of a difference: tokens both strings share, or a change that
 * replaces `removed` with `added`, either of which may be empty.
 */
type Stretch =
  | { kind: "same"; tokens: string[] }
  | { kind: "change"; removed: string[]; added: string[] };

/**
 * Reshapes token-level runs so each change reads as whole words.
 *
 * A replacement, a change that both removes and adds, takes in the shared
 * characters that touch it with no whitespace between, so "$50" to "$75"
 * reads as the whole of "$50" replaced by the whole of "$75". Changes kept
 * apart only by whitespace join into one, so alternating removed and added
 * words read as one removed phrase followed by one added phrase. A pure
 * insertion or removal keeps its exact place, such as a comma added after a
 * word.
 */
function readableRuns(runs: readonly DiffRun[]): DiffRun[] {
  const stretches: Stretch[] = [];
  for (const run of runs) {
    const last = stretches.at(-1);
    if (run.kind === "same") {
      stretches.push({ kind: "same", tokens: [...run.tokens] });
    } else if (last?.kind === "change") {
      last[run.kind].push(...run.tokens);
    } else {
      stretches.push({
        kind: "change",
        removed: run.kind === "removed" ? [...run.tokens] : [],
        added: run.kind === "added" ? [...run.tokens] : [],
      });
    }
  }
  // Each pass applies one reshaping and starts again, until none applies.
  while (reshapeOnce(stretches)) {
    // `reshapeOnce` changed `stretches` in place.
  }
  return stretches.flatMap((stretch): DiffRun[] => {
    if (stretch.kind === "same") {
      return stretch.tokens.length > 0
        ? [{ kind: "same", tokens: stretch.tokens }]
        : [];
    }
    return [
      ...(stretch.removed.length > 0
        ? [{ kind: "removed" as const, tokens: stretch.removed }]
        : []),
      ...(stretch.added.length > 0
        ? [{ kind: "added" as const, tokens: stretch.added }]
        : []),
    ];
  });
}

function isReplacement(stretch: Stretch | undefined): boolean {
  return (
    stretch?.kind === "change" &&
    stretch.removed.length > 0 &&
    stretch.added.length > 0
  );
}

/** Applies the first reshaping that fits, and answers whether one did. */
function reshapeOnce(stretches: Stretch[]): boolean {
  for (const [index, stretch] of stretches.entries()) {
    if (stretch.kind !== "change") continue;
    const previous = stretches[index - 1];
    const next = stretches[index + 1];
    const afterNext = stretches[index + 2];
    // Two changes with only whitespace between them become one, the
    // whitespace standing in both the removed and the added text.
    if (
      next?.kind === "same" &&
      afterNext?.kind === "change" &&
      next.tokens.every(isWhitespace) &&
      (isReplacement(stretch) || isReplacement(afterNext))
    ) {
      const removedGap =
        stretch.removed.length > 0 && afterNext.removed.length > 0;
      const addedGap = stretch.added.length > 0 && afterNext.added.length > 0;
      stretch.removed.push(
        ...(removedGap ? next.tokens : []),
        ...afterNext.removed
      );
      stretch.added.push(...(addedGap ? next.tokens : []), ...afterNext.added);
      stretches.splice(index + 1, 2);
      return true;
    }
    if (!isReplacement(stretch)) continue;
    // A replacement takes in the shared characters touching it.
    const before =
      previous?.kind === "same" ? previous.tokens.at(-1) : undefined;
    if (
      previous?.kind === "same" &&
      before !== undefined &&
      !isWhitespace(before)
    ) {
      previous.tokens.pop();
      stretch.removed.unshift(before);
      stretch.added.unshift(before);
      if (previous.tokens.length === 0) stretches.splice(index - 1, 1);
      return true;
    }
    const after = next?.kind === "same" ? next.tokens[0] : undefined;
    if (next?.kind === "same" && after !== undefined && !isWhitespace(after)) {
      next.tokens.shift();
      stretch.removed.push(after);
      stretch.added.push(after);
      if (next.tokens.length === 0) stretches.splice(index + 1, 1);
      return true;
    }
  }
  return false;
}

/** How many unchanged tokens stay in view on each side of a change. */
const FOLD_CONTEXT = 12;
/** A fold must leave out at least this many tokens, or the text stays whole. */
const MIN_FOLDED = 6;

/**
 * One piece of a difference read as one flow: text both strings share, text
 * only the first holds, text only the second holds, or a fold standing for
 * unchanged text left out.
 */
export type UnifiedPiece =
  | { kind: "same" | "removed" | "added"; text: string }
  | { kind: "fold" }
  | { kind: "gap" };

/**
 * The pieces of `runs` in reading order, each removed run before the added
 * run that replaces it, with a `gap` between the two that a reader sees as one
 * space. With `fold`, a shared run keeps `FOLD_CONTEXT` tokens next to each
 * change and the rest of it becomes one fold, which leaves out at least
 * `MIN_FOLDED` tokens. A difference with no change folds nothing.
 */
export function unifiedPieces(
  runs: readonly DiffRun[],
  options: { fold: boolean }
): UnifiedPiece[] {
  const changed = runs.map((run) => run.kind !== "same");
  const anyChange = changed.includes(true);
  return runs.flatMap((run, index): UnifiedPiece[] => {
    const text = run.tokens.join("");
    if (run.kind === "added" && runs[index - 1]?.kind === "removed") {
      return [{ kind: "gap" }, { kind: "added", text }];
    }
    if (run.kind !== "same") return [{ kind: run.kind, text }];
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
