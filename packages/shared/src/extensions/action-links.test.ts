import { describe, expect, it } from "vitest";
import {
  actionLinkUrlProblem,
  fillActionLinkUrl,
} from "#src/extensions/action-links";

describe("actionLinkUrlProblem", () => {
  it.each([
    "/email-preview",
    "/email-preview?workflow={workflowId}&node={nodeId}",
    "/workflows/{workflowId}/nodes/{nodeId}",
    "https://app.example.com/preview?node={nodeId}",
    "http://localhost:4017/preview",
    "HTTPS://app.example.com/workflows/{workflowId}#node-{nodeId}",
    "https://app.example.com?node={nodeId}",
  ])("accepts %s", (url) => {
    expect(actionLinkUrlProblem(url)).toBeUndefined();
  });

  it.each([
    ["a relative path", "email-preview?node={nodeId}"],
    ["a dot-relative path", "./email-preview"],
    ["a protocol-relative URL", "//evil.example.com/preview"],
    ["a backslash after the slash", "/\\evil.example.com/preview"],
    ["a bare backslash after the slash", "/\\x"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a mailto: URL", "mailto:someone@example.com"],
    ["an unknown placeholder", "/preview?member={memberId}"],
    ["a doubled brace", "/preview?node={{nodeId}}"],
    ["a stray brace", "/preview?node={nodeId"],
    ["a blank url", ""],
    ["a tab after the slash", "/\t/evil.example/p"],
    ["a newline before a backslash", "/\n\\evil.example"],
    ["a carriage return in the query", "/preview?node=\r{nodeId}"],
    ["a DEL character", "/preview\u007f"],
    ["an https: URL with one slash", "https:/preview"],
    ["an http: URL with no slash", "http:preview"],
    ["a scheme with a backslash", "https:\\\\evil.example"],
    ["a placeholder as the host", "http://{nodeId}/p"],
    ["a placeholder in the host", "https://{workflowId}.example.com/p"],
    ["a placeholder in the user info", "https://{nodeId}@app.example.com/p"],
    ["a placeholder in the port", "https://app.example.com:{nodeId}/p"],
    ["a placeholder after a third slash", "https:///{nodeId}/p"],
    ["a placeholder after a backslash", "https://\\{nodeId}/p"],
  ])("refuses %s", (_case, url) => {
    expect(actionLinkUrlProblem(url)).toBeTypeOf("string");
  });

  it("names a placeholder in the port as one before the path", () => {
    expect(actionLinkUrlProblem("https://app.example.com:{nodeId}/p")).toBe(
      "the url holds a placeholder before its path, in the host, the port or the user info"
    );
  });

  // Each starts with one `/` and then neither `/` nor `\`, so the `.`, `..`,
  // backslash or percent-encoding that follows keeps it on the origin.
  it.each([
    "/%2F%2Fevil.example",
    "/%5Cevil.example",
    "/..//evil.example",
    "/.//evil.example",
    "/./\\evil.example",
    "/..\\/evil.example",
    "/a/../..//evil.example",
    "/{nodeId}//evil.example",
  ])("accepts %s, which stays on the origin it is resolved against", (path) => {
    expect(actionLinkUrlProblem(path)).toBeUndefined();
    for (const base of [
      "https://editor.example/workflows/wf_1",
      "http://localhost:4017/a/b/",
    ]) {
      expect(new URL(path, base).origin).toBe(new URL(base).origin);
    }
  });

  it("never quotes the url it refused", () => {
    const url = "/preview?secret=hunter2&x={other}";
    expect(actionLinkUrlProblem(url)).not.toContain("hunter2");
  });
});

describe("fillActionLinkUrl", () => {
  it("writes each id in place of its placeholder, every time it appears", () => {
    expect(
      fillActionLinkUrl("/w/{workflowId}/n/{nodeId}?again={nodeId}", {
        workflowId: "wf_1",
        nodeId: "node_1",
      })
    ).toBe("/w/wf_1/n/node_1?again=node_1");
  });

  it("encodes an id so it cannot add a segment or a parameter", () => {
    expect(
      fillActionLinkUrl("/preview?node={nodeId}", {
        workflowId: "wf_1",
        nodeId: "a/b&c=d e",
      })
    ).toBe("/preview?node=a%2Fb%26c%3Dd%20e");
  });

  // A browser resolves `.` and `..` path segments, and their `%2E` spellings,
  // before it requests the page, so the check is on the path it resolves to.
  it.each([".", ".."])("draws no url for a node id of %s", (nodeId) => {
    expect(
      fillActionLinkUrl("/a/{nodeId}/b", { workflowId: "wf_1", nodeId })
    ).toBeUndefined();
    expect(
      fillActionLinkUrl("/a/{workflowId}/b", {
        workflowId: nodeId,
        nodeId: "n",
      })
    ).toBeUndefined();
  });

  it.each([
    ["an empty workflow id", { workflowId: "", nodeId: "n" }],
    ["an empty node id", { workflowId: "wf_1", nodeId: "" }],
    [
      "a node id holding a lone surrogate",
      { workflowId: "wf_1", nodeId: "n\ud800" },
    ],
    [
      "a workflow id holding a lone surrogate",
      { workflowId: "\udc00", nodeId: "n" },
    ],
  ])("draws no url for %s", (_case, ids) => {
    expect(fillActionLinkUrl("/{workflowId}/{nodeId}", ids)).toBeUndefined();
  });

  it("keeps an id holding dots among other characters in its segment", () => {
    const filled = fillActionLinkUrl("/a/{nodeId}/b", {
      workflowId: "wf_1",
      nodeId: "...",
    });
    expect(filled).toBeDefined();
    expect(new URL(filled ?? "", "https://host.example").pathname).toBe(
      "/a/.../b"
    );
  });
});
