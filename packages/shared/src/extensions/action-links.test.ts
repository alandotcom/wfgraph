import { describe, expect, it } from "vitest";
import { actionLinkUrlProblem } from "#src/extensions/action-links";

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
