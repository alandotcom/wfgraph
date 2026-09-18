import { describe, expect, it } from "vitest";
import type { GroupPort } from "#src/graph/group-boundary";
import { groupPortKey } from "#src/graph/group-port-key";

describe("groupPortKey", () => {
  it("keeps an ordinary node id and handle readable", () => {
    expect(groupPortKey({ nodeId: "qualify", handle: null })).toBe("qualify");
    expect(groupPortKey({ nodeId: "route", handle: "true" })).toBe(
      "route/true"
    );
  });

  it("names a port whose node id or handle holds a lone surrogate", () => {
    expect(groupPortKey({ nodeId: "\ud800", handle: null })).toBe("\ud800");
    expect(groupPortKey({ nodeId: "a", handle: "\udfff" })).toBe("a/\udfff");
  });

  it("gives different ports different keys when their ids hold the separator characters", () => {
    const ports: GroupPort[] = [
      { nodeId: "a/b", handle: null },
      { nodeId: "a", handle: "b" },
      { nodeId: "a/b", handle: "c" },
      { nodeId: "a", handle: "b/c" },
      { nodeId: "a%2Fb", handle: null },
      { nodeId: "a%", handle: "2Fb" },
      { nodeId: "a", handle: "" },
      { nodeId: "a/", handle: null },
      { nodeId: "", handle: null },
      { nodeId: "", handle: "" },
      { nodeId: "\ud800", handle: null },
      { nodeId: "\ud800/", handle: null },
    ];

    const keys = ports.map(groupPortKey);

    expect(new Set(keys).size).toBe(ports.length);
  });
});
