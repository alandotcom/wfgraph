import { describe, expect, it } from "vitest";
import {
  normalizeAgentEvalDocument,
  normalizeJsonEvidence,
  normalizeJsonObjectEvidence,
} from "#src/agent/evidence";

const SERIALIZATION_ERROR = "Test evidence is not JSON serializable.";

describe("normalizeJsonEvidence", () => {
  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["a bigint", BigInt(1)],
    ["a symbol", Symbol("private evidence")],
    ["a function", () => "private evidence"],
    ["a Date", new Date("2026-01-01T00:00:00.000Z")],
    ["a RegExp", /private evidence/],
    ["a Map", new Map([["key", "value"]])],
    ["a Set", new Set(["value"])],
    ["an Error", new Error("private evidence")],
    ["a Promise", Promise.resolve("private evidence")],
  ])("rejects %s", (_description, input) => {
    const value: unknown = input;

    expect(() => normalizeJsonEvidence(value, "Test evidence")).toThrow(
      SERIALIZATION_ERROR
    );
  });

  it("rejects undefined at the root", () => {
    expect(() => normalizeJsonEvidence(undefined, "Test evidence")).toThrow(
      SERIALIZATION_ERROR
    );
  });

  it("rejects undefined inside arrays", () => {
    expect(() =>
      normalizeJsonEvidence(["retained", undefined], "Test evidence")
    ).toThrow(SERIALIZATION_ERROR);
  });

  it("rejects sparse array entries", () => {
    const value: unknown[] = [];
    value.length = 1;

    expect(() => normalizeJsonEvidence(value, "Test evidence")).toThrow(
      SERIALIZATION_ERROR
    );
  });

  it("rejects circular input", () => {
    const value: { self?: unknown } = {};
    value.self = value;

    expect(() => normalizeJsonEvidence(value, "Test evidence")).toThrow(
      SERIALIZATION_ERROR
    );
  });

  it("rejects symbol-keyed object properties", () => {
    const value = { [Symbol("private evidence")]: true };

    expect(() => normalizeJsonEvidence(value, "Test evidence")).toThrow(
      SERIALIZATION_ERROR
    );
  });
});

describe("normalizeJsonObjectEvidence", () => {
  it("omits undefined fields and returns a detached copy", () => {
    const items = [{ retained: 1 }];
    const nested = { retained: true, omitted: undefined };
    const evidence = {
      retained: "value",
      omitted: undefined,
      nested,
      items,
    };

    const normalized = normalizeJsonObjectEvidence(evidence, "Test evidence");

    expect(normalized).not.toBe(evidence);
    expect(normalized.nested).not.toBe(nested);
    expect(normalized.items).not.toBe(items);
    expect(normalized.items[0]).not.toBe(items[0]);
    expect(normalized).toEqual({
      retained: "value",
      nested: { retained: true },
      items: [{ retained: 1 }],
    });
  });

  it("normalizes enumerable fields from a data class", () => {
    class EvidenceRecord {
      readonly retained = "value";
      readonly omitted = undefined;
    }

    expect(
      normalizeJsonObjectEvidence(new EvidenceRecord(), "Test evidence")
    ).toEqual({ retained: "value" });
  });
});

describe("normalizeAgentEvalDocument", () => {
  it("returns the normalized graph with undefined fields removed", () => {
    const document = {
      nodes: [
        {
          id: "entry",
          type: "action",
          width: undefined,
          position: { x: 0, y: 0 },
          data: {
            label: "Action",
            type: "action",
            description: undefined,
            config: { retained: "value", omitted: undefined },
          },
        },
      ],
      edges: [
        {
          id: "self",
          source: "entry",
          target: "entry",
          sourceHandle: undefined,
          data: { retained: true, omitted: undefined },
        },
      ],
    };

    const normalized = normalizeAgentEvalDocument(document);

    expect(normalized).not.toBe(document);
    expect(normalized).toEqual({
      nodes: [
        {
          id: "entry",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "Action",
            type: "action",
            config: { retained: "value" },
          },
        },
      ],
      edges: [
        {
          id: "self",
          source: "entry",
          target: "entry",
          data: { retained: true },
        },
      ],
    });
  });

  it("rejects a graph that loses a required field during normalization", () => {
    expect(() =>
      normalizeAgentEvalDocument({
        nodes: [
          {
            id: undefined,
            position: { x: 0, y: 0 },
            data: { label: "Lifecycle", type: "lifecycle" },
          },
        ],
        edges: [],
      })
    ).toThrow(/Agent eval final document has an invalid graph shape:[\s\S]*id/);
  });

  it("rejects an unknown final graph field", () => {
    expect(() =>
      normalizeAgentEvalDocument({ nodes: [], edges: [], unexpected: true })
    ).toThrow(
      /Agent eval final document has an invalid graph shape:[\s\S]*unexpected/
    );
  });

  it("rejects non-JSON graph data before parsing the graph shape", () => {
    expect(() =>
      normalizeAgentEvalDocument({
        nodes: [
          {
            id: "entry",
            position: { x: Number.NaN, y: 0 },
            data: { label: "Lifecycle", type: "lifecycle" },
          },
        ],
        edges: [],
      })
    ).toThrow("Agent eval final document is not JSON serializable.");
  });
});
