import { type ClassValue, clsx } from "clsx";
import { Schema } from "effect";
import { twMerge } from "tailwind-merge";
import { readAs } from "#src/types/schema";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The two typed reads every walk below ends in.
 *
 * A thrown value arrives as `unknown` and belongs to whoever threw it, so
 * nothing about its shape can be assumed. `readAs` is what lets each leaf be
 * read on its own terms: a `message` that came back as a number says nothing
 * about whether `reason` beside it is still a usable string, and reading one
 * leaf at a time is what keeps a mistyped member from hiding the rest. See
 * `types/schema.ts` for why a single struct schema cannot do this job.
 */
const readString = readAs(Schema.String);
// `Finite`, not `Number`: an HTTP status of `NaN` is not a status, and printing
// one beside the status text would be worse than leaving it out.
const readNumber = readAs(Schema.Finite);

/**
 * Every place an SDK is known to leave its message, in the order this project
 * prefers them. The first path that lands on a string with something in it
 * wins, so a path that names a location precisely sits above the one that would
 * otherwise shadow it.
 */
const MESSAGE_PATHS: readonly (readonly string[])[] = [
  ["message"],
  ["responseBody", "error"],
  ["responseBody", "error", "message"],
  ["error"],
  ["error", "message"],
  ["data", "error"],
  ["data", "message"],
  ["reason"],
];

/**
 * Follows `path` through a value nobody validated, answering `undefined` as
 * soon as a hop has nowhere to land.
 *
 * Each hop reads the member the way the language does, following the prototype
 * chain: an SDK error class defines `message` as a getter on its prototype,
 * which a key lookup through `Object.hasOwn` would miss entirely.
 */
function readValueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;

  for (const key of path) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }

    // `Reflect.get` is the typed way to ask an object of unknown shape for a
    // member: it takes any object, reads the prototype chain, and answers
    // whatever is there. What comes back is unchecked, which is what the
    // `readAs` readers above are for.
    current = Reflect.get(current, key);
  }

  return current;
}

/**
 * The same walk, kept only when it ends on a string carrying something. An
 * empty string is a field that was populated with nothing, which tells a reader
 * as little as a missing field does.
 */
function readMessageAt(
  value: unknown,
  path: readonly string[]
): string | undefined {
  const message = readString(readValueAt(value, path));

  return message === "" ? undefined : message;
}

/**
 * A readable sentence from a thrown value of unknown shape. Synchronous: a
 * Promise needs `getErrorMessageAsync`.
 */
export function getErrorMessage(error: unknown): string {
  if (error === null || error === undefined) {
    return "Unknown error";
  }

  if (error instanceof Error) {
    // A `Schema.TaggedError` declares no message field, so its `.message`
    // is the empty string and its `.name` is the tag. Falling back to the name
    // is what keeps a run-log row and a terminal record a sentence rather than
    // a blank, on both sides of the colon.
    const message = error.message || error.name;

    if (error.cause instanceof Error) {
      return `${message}: ${error.cause.message || error.cause.name}`;
    }
    return message;
  }

  if (typeof error === "string") {
    return error;
  }

  // An array names its members by position and a function names none at all, so
  // neither can be the envelope the paths below read by key.
  if (typeof error !== "object" || Array.isArray(error)) {
    return "Unknown error";
  }

  for (const path of MESSAGE_PATHS) {
    const message = readMessageAt(error, path);
    if (message !== undefined) {
      return message;
    }
  }

  // An HTTP error says what went wrong across two fields, so this one is
  // composed rather than read.
  const statusText = readMessageAt(error, ["statusText"]);
  if (statusText !== undefined) {
    const status = readNumber(readValueAt(error, ["status"]));
    return status === undefined ? statusText : `${statusText} (${status})`;
  }

  // Nothing known was found, so describe the value itself. Both fallbacks read
  // the value the caller was handed, which is the only thing that still tells
  // them where it came from.
  try {
    const stringified = JSON.stringify(error, null, 0);
    if (stringified && stringified !== "{}" && stringified.length < 500) {
      return stringified;
    }
  } catch {
    // A circular structure or a throwing `toJSON` leaves nothing to print.
  }

  const objectToString = Object.prototype.toString.call(error);

  return objectToString === "[object Object]"
    ? "Unknown error"
    : objectToString;
}

/**
 * Same as `getErrorMessage`, waiting on a Promise or thenable first.
 */
export async function getErrorMessageAsync(error: unknown): Promise<string> {
  if (error instanceof Promise) {
    try {
      const resolvedValue = await error;
      return getErrorMessage(resolvedValue);
    } catch (rejectedError) {
      return getErrorMessage(rejectedError);
    }
  }

  // Any object carrying a callable `then` is awaitable the same way.
  if (typeof readValueAt(error, ["then"]) === "function") {
    try {
      const resolvedValue = await Promise.resolve(error);
      return getErrorMessage(resolvedValue);
    } catch (rejectedError) {
      return getErrorMessage(rejectedError);
    }
  }

  return getErrorMessage(error);
}
