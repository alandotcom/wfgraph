/**
 * What the run-log scrubber answers.
 *
 * Its result goes straight into a JSONB column, so the two things under test are
 * that a secret is masked and that what comes back is JSON: a value the format
 * has no spelling for must not reach the driver, which stringifies whatever it
 * is handed.
 */

import { describe, expect, it } from "vitest";
import {
  redactSensitiveData,
  redactWorkflowGraph,
} from "#src/backend/lib/utils/redact";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";

describe("redactSensitiveData", () => {
  it("masks a secret by its key and leaves the rest alone", () => {
    expect(
      redactSensitiveData({ to: "+15550100", apiKey: "sk_live_abcd1234" })
    ).toEqual({ to: "+15550100", apiKey: "********1234" });
  });

  it("masks a non-string secret whole, having no tail to show", () => {
    expect(redactSensitiveData({ token: { value: "x" } })).toEqual({
      token: "[REDACTED]",
    });
  });

  it("drops a key holding nothing, as serializing would", () => {
    expect(redactSensitiveData({ eventName: undefined, id: "1" })).toEqual({
      id: "1",
    });
  });

  it("drops a sensitive key holding nothing rather than masking it", () => {
    expect(redactSensitiveData({ token: undefined, id: "1" })).toEqual({
      id: "1",
    });
  });

  it("leaves a sensitive key holding null as null, not a masked secret", () => {
    expect(redactSensitiveData({ apiKey: null, id: "1" })).toEqual({
      apiKey: null,
      id: "1",
    });
  });

  it("drops a key JSON cannot spell", () => {
    expect(redactSensitiveData({ render: () => "x", id: "1" })).toEqual({
      id: "1",
    });
  });

  it("answers null for such a value inside a list, where a key cannot go", () => {
    expect(redactSensitiveData([1, () => "x"])).toEqual([1, null]);
  });

  it("passes a bare JSON value through", () => {
    expect(redactSensitiveData("plain")).toBe("plain");
    expect(redactSensitiveData(null)).toBeNull();
    expect(redactSensitiveData(undefined)).toBeUndefined();
  });
});

describe("redactWorkflowGraph", () => {
  // A value pasted into a node's config -- an API key tried out while wiring an
  // action -- must not survive into a version's graph once it leaves the
  // service, the same as it cannot survive into a logged input or output.
  it("masks a sensitive value inside a node's config", () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        {
          id: "node_1",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "Send email",
            type: "action",
            config: { apiKey: "sk_live_abcd1234", to: "+15550100" },
          },
        },
      ],
      edges: [],
    });

    const redacted = redactWorkflowGraph(graph);
    const node = redacted.nodes.find((candidate) => candidate.key === "node_1");

    expect(node?.attributes.data.config).toEqual({
      apiKey: "********1234",
      to: "+15550100",
    });
  });

  // An edge's `data` is the same open, author-writable JSON bag as a node's
  // `data.config`: the run-overlay code sets a `displayLabel` there today, but
  // the wire schema (`workflowEdgeAttributesSchema`) permits any key, so a
  // secret pasted onto an edge must be masked exactly like one on a node.
  it("masks a sensitive value inside an edge's data", () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        {
          id: "node_1",
          type: "lifecycle",
          position: { x: 0, y: 0 },
          data: { label: "Start", type: "lifecycle" },
        },
        {
          id: "node_2",
          type: "action",
          position: { x: 100, y: 0 },
          data: { label: "Act", type: "action", config: {} },
        },
      ],
      edges: [
        {
          id: "edge_1",
          source: "node_1",
          target: "node_2",
          data: { apiKey: "sk_live_abcd1234", displayLabel: "on success" },
        },
      ],
    });

    const redacted = redactWorkflowGraph(graph);
    const edge = redacted.edges.find((candidate) => candidate.key === "edge_1");

    expect(edge?.attributes.data).toEqual({
      apiKey: "********1234",
      displayLabel: "on success",
    });
  });

  // Structure -- node and edge keys, positions, edge endpoints -- survives
  // untouched: only leaf values under sensitive keys are masked, and the graph
  // the editor draws from this response has to keep its shape.
  it("leaves node and edge structure untouched", () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        {
          id: "node_1",
          type: "lifecycle",
          position: { x: 10, y: 20 },
          data: { label: "Start", type: "lifecycle" },
        },
        {
          id: "node_2",
          type: "action",
          position: { x: 30, y: 40 },
          data: { label: "Act", type: "action", config: {} },
        },
      ],
      edges: [{ id: "edge_1", source: "node_1", target: "node_2" }],
    });

    const redacted = redactWorkflowGraph(graph);

    expect(redacted.nodes.map((node) => node.key)).toEqual([
      "node_1",
      "node_2",
    ]);
    expect(redacted.nodes[0]?.attributes.position).toEqual({ x: 10, y: 20 });
    expect(redacted.edges[0]).toMatchObject({
      key: "edge_1",
      source: "node_1",
      target: "node_2",
    });
  });
});
