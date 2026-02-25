import { describe, expect, it } from "bun:test";
import { getRpcErrorMessage } from "@/rpc/error-message";

describe("getRpcErrorMessage", () => {
  it("returns the string payload as-is when provided", () => {
    expect(getRpcErrorMessage("Direct error")).toBe("Direct error");
  });

  it("falls back when payload is empty or invalid", () => {
    expect(getRpcErrorMessage(null, "Fallback")).toBe("Fallback");
    expect(getRpcErrorMessage({}, "Fallback")).toBe("Fallback");
  });

  it("prefers the error field over message/details", () => {
    expect(
      getRpcErrorMessage({
        error: "Top-level error",
        message: "Secondary",
        details: "Tertiary",
      })
    ).toBe("Top-level error");
  });

  it("appends invalid integration IDs for integration validation failures", () => {
    expect(
      getRpcErrorMessage({
        error: "Workflow contains invalid integration references",
        code: "integration_validation_failed",
        invalidIntegrationIds: ["int_1", "int_2"],
      })
    ).toBe(
      "Workflow contains invalid integration references (invalid integration IDs: int_1, int_2)"
    );
  });
});
