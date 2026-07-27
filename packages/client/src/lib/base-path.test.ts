import { afterEach, describe, expect, it } from "bun:test";
import { getBasePath } from "./base-path";

// The server injects <base href> into index.html, and this tag is the only
// channel the mount point travels to the browser through. Everything the client
// addresses by a root-relative URL has to add it back by hand, because a URL
// starting with "/" ignores <base href> entirely.
function setBaseHref(href: string | null): void {
  document.head.innerHTML = href === null ? "" : `<base href="${href}" />`;
}

afterEach(() => {
  document.head.innerHTML = "";
});

describe("getBasePath", () => {
  it("reads the mount point off the base tag, without its trailing slash", () => {
    setBaseHref("/rova/");
    expect(getBasePath()).toBe("/rova");
  });

  it("reports no prefix when Rova owns the root", () => {
    setBaseHref("/");
    expect(getBasePath()).toBe("");
  });

  it("reports no prefix when the document carries no base tag", () => {
    setBaseHref(null);
    expect(getBasePath()).toBe("");
  });

  it("composes into a root-relative API URL", () => {
    setBaseHref("/rova/");
    expect(`${getBasePath()}/api/extensions`).toBe("/rova/api/extensions");

    setBaseHref("/");
    expect(`${getBasePath()}/api/extensions`).toBe("/api/extensions");
  });
});
