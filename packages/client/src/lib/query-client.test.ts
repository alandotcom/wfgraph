import { describe, expect, it } from "vitest";
import { ApiError } from "./rpc-client";
import { mutationErrorToast } from "./query-client";

// Six mutations across the client depend on which of these three answers they
// get, and two of them read as the same thing at a glance: saying nothing and
// saying nothing in particular.

describe("mutationErrorToast", () => {
  it("prefers the message the call site chose", () => {
    expect(
      mutationErrorToast(new ApiError(500, "constraint violated"), {
        errorMessage: "Failed to delete workflow. Please try again.",
      })
    ).toBe("Failed to delete workflow. Please try again.");
  });

  it("falls back to what the server said when no message is given", () => {
    expect(
      mutationErrorToast(new ApiError(409, "Name already taken"), {})
    ).toBe("Name already taken");
  });

  it("falls back for a mutation carrying no meta at all", () => {
    expect(mutationErrorToast(new ApiError(500, "Boom"), undefined)).toBe(
      "Boom"
    );
  });

  it("says nothing when the call site shows the failure itself", () => {
    expect(
      mutationErrorToast(new ApiError(400, "Invalid"), {
        errorShownByCaller: true,
      })
    ).toBeNull();
  });

  it("still says nothing when a message is set alongside the opt-out", () => {
    expect(
      mutationErrorToast(new ApiError(400, "Invalid"), {
        errorMessage: "unused",
        errorShownByCaller: true,
      })
    ).toBeNull();
  });

  it("has something to say about a rejection that is not an Error", () => {
    expect(mutationErrorToast("dropped connection", {})).toBe("Request failed");
  });
});
