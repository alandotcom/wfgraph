import { describe, expect, it } from "vitest";
import { getErrorMessage, getErrorMessageAsync } from "./utils";

/**
 * A thrown value reaches `getErrorMessage` as `unknown` and is parsed here into
 * a typed error envelope. These cases cover both halves of that parse: the
 * shapes it admits, and the shapes it turns away so the caller still gets a
 * usable message.
 */
describe("getErrorMessage", () => {
  it("reads an Error and appends the cause when one is chained", () => {
    const withCause = new Error("Request failed");
    withCause.cause = new Error("socket hang up");

    expect(getErrorMessage(new Error("Request failed"))).toBe("Request failed");
    expect(getErrorMessage(withCause)).toBe("Request failed: socket hang up");
  });

  it("passes a thrown string through and names a thrown nothing", () => {
    expect(getErrorMessage("Rate limited")).toBe("Rate limited");
    expect(getErrorMessage(null)).toBe("Unknown error");
    expect(getErrorMessage(undefined)).toBe("Unknown error");
  });

  it("reads the message off each place an SDK is known to put it", () => {
    expect(getErrorMessage({ message: "Plain message" })).toBe("Plain message");
    expect(getErrorMessage({ responseBody: { error: "Body text" } })).toBe(
      "Body text"
    );
    expect(
      getErrorMessage({ responseBody: { error: { message: "Body object" } } })
    ).toBe("Body object");
    expect(getErrorMessage({ error: "Top level" })).toBe("Top level");
    expect(getErrorMessage({ error: { message: "Nested object" } })).toBe(
      "Nested object"
    );
    expect(getErrorMessage({ data: { error: "Data error" } })).toBe(
      "Data error"
    );
    expect(getErrorMessage({ data: { message: "Data message" } })).toBe(
      "Data message"
    );
    expect(getErrorMessage({ reason: "Aborted" })).toBe("Aborted");
  });

  it("builds an HTTP message from statusText and status together", () => {
    expect(
      getErrorMessage({ statusText: "Too Many Requests", status: 429 })
    ).toBe("Too Many Requests (429)");
    expect(getErrorMessage({ statusText: "Bad Gateway" })).toBe("Bad Gateway");
  });

  it("reads a message carried on the prototype, as an SDK error class does", () => {
    // The parse must see inherited members, because an SDK error class puts its
    // getters on the prototype rather than on each instance.
    const sdkError: unknown = Object.create({
      get message() {
        return "Prototype message";
      },
    });

    expect(getErrorMessage(sdkError)).toBe("Prototype message");
  });

  it("drops a mistyped field and keeps reading its siblings", () => {
    // A number in `message` is no message at all, so the search continues.
    expect(getErrorMessage({ message: 7, reason: "Aborted" })).toBe("Aborted");
  });

  it("stringifies an object that carries no known message field", () => {
    expect(getErrorMessage({ message: 7 })).toBe('{"message":7}');
    expect(getErrorMessage({})).toBe("Unknown error");
  });

  it("describes the value it was actually handed, not a copy of it", () => {
    // Parsing yields a fresh plain object, so a fallback reading the parse
    // result would report "[object Object]" for every one of these. Both
    // fallbacks read the original value.
    expect(getErrorMessage(new Map())).toBe("[object Map]");
    expect(getErrorMessage(new Date("2026-02-11T18:00:00Z"))).toBe(
      '"2026-02-11T18:00:00.000Z"'
    );
  });

  it("turns away an array and a function, which carry no error envelope", () => {
    expect(getErrorMessage([{ message: "inside an array" }])).toBe(
      "Unknown error"
    );
    expect(getErrorMessage(() => "thrown function")).toBe("Unknown error");
  });
});

describe("getErrorMessageAsync", () => {
  it("settles a rejected promise before reading it", async () => {
    expect(await getErrorMessageAsync(Promise.reject(new Error("Timed out")))) //
      .toBe("Timed out");
  });

  it("settles a thenable that is not a real promise", async () => {
    // Some SDKs hand back their own awaitable, so a callable `then` is the test
    // that matters here, and `instanceof Promise` would miss it.
    const thenable = {
      // oxlint-disable-next-line unicorn/no-thenable -- carrying `then` is the shape under test
      then: (resolve: (value: unknown) => void) => {
        resolve({ message: "Resolved message" });
      },
    };

    expect(await getErrorMessageAsync(thenable)).toBe("Resolved message");
  });

  it("reads a plain value without awaiting anything", async () => {
    expect(await getErrorMessageAsync({ reason: "Aborted" })).toBe("Aborted");

    // A `then` that is not callable does not make a value awaitable.
    // oxlint-disable-next-line unicorn/no-thenable -- carrying `then` is the shape under test
    const notThenable = { then: "soon", reason: "Aborted" };

    expect(await getErrorMessageAsync(notThenable)).toBe("Aborted");
  });
});
