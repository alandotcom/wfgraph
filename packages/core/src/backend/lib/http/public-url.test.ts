import { describe, expect, it } from "vitest";
import { resolvePublicUrl } from "#src/backend/lib/http/public-url";

describe("resolvePublicUrl", () => {
  it("normalizes an HTTPS origin and loopback HTTP origins", () => {
    expect(resolvePublicUrl("  https://workflows.example.com/  ")).toBe(
      "https://workflows.example.com"
    );
    expect(resolvePublicUrl("http://localhost:4017")).toBe(
      "http://localhost:4017"
    );
    expect(resolvePublicUrl("http://dev.localhost:4017")).toBe(
      "http://dev.localhost:4017"
    );
    expect(resolvePublicUrl("http://127.0.0.1:4017")).toBe(
      "http://127.0.0.1:4017"
    );
    expect(resolvePublicUrl("http://[::1]:4017")).toBe("http://[::1]:4017");
  });

  it("reads an unset option as unset", () => {
    expect(resolvePublicUrl(undefined)).toBeUndefined();
    expect(resolvePublicUrl("   ")).toBeUndefined();
  });

  it("refuses a value carrying the mount path", () => {
    expect(() => resolvePublicUrl("https://example.com/workflows")).toThrow(
      /names the origin alone/
    );
  });

  it("refuses a relative value", () => {
    expect(() => resolvePublicUrl("workflows.example.com")).toThrow(
      /must be an absolute URL/
    );
  });

  it("refuses a non-HTTP scheme", () => {
    expect(() => resolvePublicUrl("ftp://example.com")).toThrow(
      /must be an http or https URL/
    );
  });

  it("refuses HTTP for a non-loopback host", () => {
    expect(() => resolvePublicUrl("http://workflows.example.com")).toThrow(
      /HTTPS or a loopback HTTP origin/
    );
  });

  it.each([
    "http://user:secret@example.com/path?token=query-secret#fragment-secret",
    "workflows.example.com/private?token=query-secret#fragment-secret",
    "ftp://user:secret@example.com/private?token=query-secret#fragment-secret",
  ])("does not quote the rejected value in an error", (value) => {
    expect(() => resolvePublicUrl(value)).toThrow(
      expect.not.objectContaining({ message: expect.stringContaining(value) })
    );
    for (const secret of [
      "secret",
      "private",
      "query-secret",
      "fragment-secret",
    ]) {
      expect(() => resolvePublicUrl(value)).toThrow(
        expect.not.objectContaining({
          message: expect.stringContaining(secret),
        })
      );
    }
  });
});
