import {
  ExternalRejected,
  ExternalUnreachable,
  ExternalUnreadable,
  type JsonValue,
} from "@wfgraph/core/plugin";
import { describe, expect, it } from "vitest";
import {
  carriesLinearErrors,
  describeLinearFailure,
  isLinearAuthenticationFailure,
  readLinearErrors,
} from "#src/linear/errors";
import { linearResponses } from "#src/linear/responses.fixtures";

/**
 * How a failed call to Linear reads: which body counts as Linear refusing the
 * operation, which sentence a step's failure carries, and which refusal is
 * Linear rejecting the API key. The bodies follow Linear's error format, an
 * `errors` array whose entries carry `message` and `extensions`.
 */

function rejected(status: number, payload: JsonValue | undefined) {
  return new ExternalRejected({
    status,
    payload,
    retryAfterSeconds: undefined,
  });
}

const { authenticationError, rateLimited } = linearResponses;

describe("carriesLinearErrors", () => {
  it("reads a body with GraphQL errors as a refusal", () => {
    expect(carriesLinearErrors(authenticationError)).toBe(true);
    expect(carriesLinearErrors({ data: null, ...rateLimited })).toBe(true);
  });

  it("reads a body with data and no errors as an answer", () => {
    expect(carriesLinearErrors(linearResponses.viewer)).toBe(false);
    expect(carriesLinearErrors({ errors: [] })).toBe(false);
    expect(carriesLinearErrors(undefined)).toBe(false);
  });
});

describe("readLinearErrors", () => {
  it("keeps the fields this integration reads", () => {
    expect(readLinearErrors(authenticationError)).toEqual([
      {
        message: "Authentication required, not authenticated",
        extensions: {
          type: "authentication error",
          code: "AUTHENTICATION_ERROR",
          userPresentableMessage:
            "You need to authenticate to access this operation.",
        },
      },
    ]);
  });
});

describe("describeLinearFailure", () => {
  it("prefers the message Linear writes for a person", () => {
    expect(describeLinearFailure(rejected(400, authenticationError))).toBe(
      "You need to authenticate to access this operation."
    );
  });

  it("falls back to the GraphQL error's message", () => {
    expect(describeLinearFailure(rejected(429, rateLimited))).toBe(
      "Rate limit exceeded"
    );
  });

  it("falls back to the HTTP status when the body is not Linear's", () => {
    expect(describeLinearFailure(rejected(502, undefined))).toBe("HTTP 502");
  });

  it("says what the transport said for a request that never arrived", () => {
    expect(
      describeLinearFailure(
        new ExternalUnreachable({ message: "socket hang up" })
      )
    ).toBe("socket hang up");
  });

  it("names a success whose body could not be read", () => {
    expect(describeLinearFailure(new ExternalUnreadable({ status: 200 }))).toBe(
      "Linear answered 200 with an unrecognized body"
    );
  });
});

describe("isLinearAuthenticationFailure", () => {
  it("recognizes Linear's authentication error at either status", () => {
    expect(
      isLinearAuthenticationFailure(rejected(400, authenticationError))
    ).toBe(true);
    expect(
      isLinearAuthenticationFailure(rejected(401, authenticationError))
    ).toBe(true);
  });

  it("recognizes the code alone", () => {
    expect(
      isLinearAuthenticationFailure(
        rejected(200, {
          errors: [
            {
              message: "Authentication required, not authenticated",
              extensions: { code: "AUTHENTICATION_ERROR" },
            },
          ],
        })
      )
    ).toBe(true);
  });

  it("counts a bare 401", () => {
    expect(isLinearAuthenticationFailure(rejected(401, undefined))).toBe(true);
  });

  it("leaves every other refusal alone", () => {
    expect(isLinearAuthenticationFailure(rejected(429, rateLimited))).toBe(
      false
    );
    expect(isLinearAuthenticationFailure(rejected(400, undefined))).toBe(false);
    expect(
      isLinearAuthenticationFailure(new ExternalUnreachable({ message: "x" }))
    ).toBe(false);
  });
});
