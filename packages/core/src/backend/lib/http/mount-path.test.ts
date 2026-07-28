import { describe, expect, it } from "vitest";
import {
  normalizeBasePath,
  rewriteClientBaseHref,
  toMountRelativePath,
} from "#src/backend/lib/http/mount-path";

describe("normalizeBasePath", () => {
  it("treats the root as no prefix at all", () => {
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("   ")).toBe("");
  });

  it("keeps a sub-path with a leading slash and no trailing one", () => {
    expect(normalizeBasePath("/rova")).toBe("/rova");
    expect(normalizeBasePath("/rova/")).toBe("/rova");
    expect(normalizeBasePath("  /rova/nested//  ")).toBe("/rova/nested");
  });

  it("adds the leading slash a host left off", () => {
    expect(normalizeBasePath("rova")).toBe("/rova");
  });

  it("refuses a path that would escape the mount or break a URL", () => {
    expect(() => normalizeBasePath("/rova/../etc")).toThrow(
      "unusable basePath"
    );
    expect(() => normalizeBasePath("/rova//deep")).toThrow("unusable basePath");
    expect(() => normalizeBasePath("/rova?x=1")).toThrow("unusable basePath");
    expect(() => normalizeBasePath("//evil.example.com")).toThrow(
      "unusable basePath"
    );
  });
});

describe("toMountRelativePath", () => {
  it("passes a pathname through untouched when Rova owns the root", () => {
    expect(toMountRelativePath("/api/extensions", "")).toBe("/api/extensions");
    expect(toMountRelativePath("/", "")).toBe("/");
  });

  it("strips the prefix, mapping the bare mount point to the root", () => {
    expect(toMountRelativePath("/rova", "/rova")).toBe("/");
    expect(toMountRelativePath("/rova/", "/rova")).toBe("/");
    expect(toMountRelativePath("/rova/api/extensions", "/rova")).toBe(
      "/api/extensions"
    );
  });

  it("reports a request that landed outside the mount", () => {
    expect(toMountRelativePath("/api/extensions", "/rova")).toBeNull();
    // A sibling path that merely shares the prefix as a string is not inside it.
    expect(toMountRelativePath("/rovally/api", "/rova")).toBeNull();
  });
});

describe("rewriteClientBaseHref", () => {
  it("points the base tag at the mount point", () => {
    expect(rewriteClientBaseHref('<base href="/">', "/rova")).toBe(
      '<base href="/rova/" />'
    );
  });

  // packages/client/src/index.html writes the self-closing form and Vite copies it
  // through, so this is the shape the real built client actually arrives in.
  it("rewrites the self-closing form the client build emits", () => {
    expect(
      rewriteClientBaseHref('<head><base href="/" /></head>', "/rova")
    ).toBe('<head><base href="/rova/" /></head>');
  });

  it("leaves the root mount serving a root base href", () => {
    expect(rewriteClientBaseHref('<base href="/" />', "")).toBe(
      '<base href="/" />'
    );
  });

  it("reports a bundle that carries no base tag", () => {
    expect(rewriteClientBaseHref("<head></head>", "/rova")).toBeNull();
  });
});
