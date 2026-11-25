import { describe, expect, it } from "vitest";
import { distinctNodeNames, nodePlaces } from "#src/lib/node-place";

type TestNode = { id: string; label: string; parentId?: string | undefined };

const nameOf = (node: TestNode) => node.label;

const nodes: TestNode[] = [
  { id: "lifecycle", label: "Lifecycle" },
  { id: "send", label: "Send email" },
  { id: "first", label: "Action" },
  { id: "lookups", label: "Lookups" },
  { id: "second", label: "Action", parentId: "lookups" },
  { id: "notify", label: "Notify" },
];

const edges = [
  { source: "lifecycle", target: "send" },
  { source: "send", target: "first" },
  { source: "first", target: "second" },
  { source: "second", target: "notify" },
];

describe("nodePlaces", () => {
  it("names a step's Group and the step before it, and nothing for the entry", () => {
    const places = nodePlaces({ nodes, edges, nameOf });

    expect(places.get("first")).toBe("after Send email");
    expect(places.get("second")).toBe("in Lookups, after Action");
    expect(places.has("lifecycle")).toBe(false);
  });

  it("reads the first incoming connection when several reach a step", () => {
    const places = nodePlaces({
      nodes,
      edges: [...edges, { source: "notify", target: "first" }],
      nameOf,
    });

    expect(places.get("first")).toBe("after Send email");
  });
});

describe("distinctNodeNames", () => {
  it("adds the place only to names that more than one step shares", () => {
    const names = distinctNodeNames({ nodes, edges, nameOf });

    expect(names.get("first")).toBe("Action (after Send email)");
    expect(names.get("second")).toBe("Action (in Lookups, after Action)");
    expect(names.get("send")).toBe("Send email");
    expect(names.get("notify")).toBe("Notify");
  });

  it("never prints an id", () => {
    const names = distinctNodeNames({ nodes, edges, nameOf });

    for (const name of names.values()) {
      expect(name).not.toMatch(/lifecycle|first|second|lookups/);
    }
  });
});
