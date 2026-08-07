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
    expect(normalizeBasePath("/wfgraph")).toBe("/wfgraph");
    expect(normalizeBasePath("/wfgraph/")).toBe("/wfgraph");
    expect(normalizeBasePath("  /wfgraph/nested//  ")).toBe("/wfgraph/nested");
  });

  it("adds the leading slash a host left off", () => {
    expect(normalizeBasePath("wfgraph")).toBe("/wfgraph");
  });

  it("refuses a path that would escape the mount or break a URL", () => {
    expect(() => normalizeBasePath("/wfgraph/../etc")).toThrow(
      "unusable basePath"
    );
    expect(() => normalizeBasePath("/wfgraph//deep")).toThrow(
      "unusable basePath"
    );
    expect(() => normalizeBasePath("/wfgraph?x=1")).toThrow(
      "unusable basePath"
    );
    expect(() => normalizeBasePath("//evil.example.com")).toThrow(
      "unusable basePath"
    );
  });
});

describe("toMountRelativePath", () => {
  it("passes a pathname through untouched when Workflow Graph owns the root", () => {
    expect(toMountRelativePath("/api/extensions", "")).toBe("/api/extensions");
    expect(toMountRelativePath("/", "")).toBe("/");
  });

  it("strips the prefix, mapping the bare mount point to the root", () => {
    expect(toMountRelativePath("/wfgraph", "/wfgraph")).toBe("/");
    expect(toMountRelativePath("/wfgraph/", "/wfgraph")).toBe("/");
    expect(toMountRelativePath("/wfgraph/api/extensions", "/wfgraph")).toBe(
      "/api/extensions"
    );
  });

  it("reports a request that landed outside the mount", () => {
    expect(toMountRelativePath("/api/extensions", "/wfgraph")).toBeNull();
    // A sibling path that merely shares the prefix as a string is not inside it.
    expect(toMountRelativePath("/wfgraphlly/api", "/wfgraph")).toBeNull();
  });
});

describe("rewriteClientBaseHref", () => {
  it("points the base tag at the mount point", () => {
    expect(rewriteClientBaseHref('<base href="/">', "/wfgraph")).toBe(
      '<base href="/wfgraph/" />'
    );
  });

  // packages/client/src/index.html writes the self-closing form and Vite copies it
  // through, so this is the shape the real built client actually arrives in.
  it("rewrites the self-closing form the client build emits", () => {
    expect(
      rewriteClientBaseHref('<head><base href="/" /></head>', "/wfgraph")
    ).toBe('<head><base href="/wfgraph/" /></head>');
  });

  it("leaves the root mount serving a root base href", () => {
    expect(rewriteClientBaseHref('<base href="/" />', "")).toBe(
      '<base href="/" />'
    );
  });

  it("reports a bundle that carries no base tag", () => {
    expect(rewriteClientBaseHref("<head></head>", "/wfgraph")).toBeNull();
  });
});
