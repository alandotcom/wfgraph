import {
  GraphQLClientError,
  LinearErrorType,
  type LinearRawResponse,
  RatelimitedLinearError,
} from "@linear/sdk";
import { describe, expect, it } from "vitest";
import { toLinearError } from "#src/linear/errors";

/**
 * What `toLinearError` is handed is whatever was thrown, and a throwable keeps
 * some of its members on its prototype: `name` comes from `Error.prototype`
 * unless a class assigns it. Effect Schema reads own keys only, where Zod
 * reached through the prototype chain, so this pins which members of a real
 * thrown error survive the decode.
 *
 * `GraphQLClientError` is Linear's own copy of graphql-request's `ClientError`,
 * thrown by a custom GraphQL client talking to Linear. That is the case this
 * schema exists for: the SDK's own client wraps its failures in a `LinearError`
 * before they get here.
 */
describe("toLinearError", () => {
  // The response is written as the API sends it: readable text for the error
  // message and a lowercase phrase for its type, where Linear's own type names
  // its LinearErrorType enum. `errors.ts` documents the same disagreement, and
  // Linear maps the text back to the enum itself.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const wireResponse = {
    status: 429,
    headers: new Headers({ "retry-after": "30" }),
    errors: [
      {
        message: "Rate limit exceeded",
        extensions: { type: "ratelimited", userError: true },
      },
    ],
  } as unknown as LinearRawResponse<unknown>;

  function thrownClientError() {
    return new GraphQLClientError(wireResponse, {
      query: "query Me { viewer { id } }",
      variables: { id: "1" },
    });
  }

  it("classifies a thrown GraphQL client error", () => {
    const linearError = toLinearError(thrownClientError());

    if (!(linearError instanceof RatelimitedLinearError)) {
      throw new Error(`Expected a rate-limited error, got ${linearError.type}`);
    }

    expect(linearError.type).toBe(LinearErrorType.Ratelimited);
    expect(linearError.message).toBe("Rate limit exceeded");
    expect(linearError.status).toBe(429);
    expect(linearError.errors?.[0]?.message).toBe("Rate limit exceeded");
    expect(linearError.query).toBe("query Me { viewer { id } }");
    expect(linearError.variables).toEqual({ id: "1" });
    // Read back off `response.headers`, so the `Headers` object crossed the
    // decode intact rather than being flattened into a plain value.
    expect(linearError.retryAfter).toBe(30);
  });

  it("loses only the members the thrown error keeps on its prototype", () => {
    const thrown = thrownClientError();

    expect(Object.hasOwn(thrown, "name")).toBe(false);
    expect(Object.hasOwn(thrown, "message")).toBe(true);
    expect(Object.hasOwn(thrown, "response")).toBe(true);
    expect(Object.hasOwn(thrown, "request")).toBe(true);

    // `name` is the one member the decode cannot see, and nothing downstream
    // asks for it: Linear classifies on `response.errors` and `response.status`
    // and builds its message from `message`, `response.error`, and the first
    // GraphQL error.
    expect(toLinearError(thrown).raw?.name).toBeUndefined();
  });
});
