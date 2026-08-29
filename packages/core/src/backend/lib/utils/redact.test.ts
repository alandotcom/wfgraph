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
  redactSensitiveText,
  redactWorkflowGraph,
} from "#src/backend/lib/utils/redact";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";

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

  it("does not return an uninspected secret below the recursion limit", () => {
    let nested: Record<string, unknown> = { token: "deep-secret" };
    for (let depth = 0; depth < 12; depth += 1) {
      nested = { child: nested };
    }

    const serialized = JSON.stringify(redactSensitiveData(nested));
    expect(serialized).not.toContain("deep-secret");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts every camel-case sensitive key variant", () => {
    const redacted = redactSensitiveData({
      privateKey: "private-value",
      phoneNumber: "800-555-0100",
      creditCard: "4111111111111111",
      socialSecurity: "123-45-6789",
      fromEmail: "sender@example.com",
      databaseUrl: "postgres://example",
      connectionString: "postgres://example",
      cardNumber: "4111111111111111",
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain("private-value");
    expect(serialized).not.toContain("800-555-0100");
    expect(serialized).not.toContain("4111111111111111");
    expect(serialized).not.toContain("123-45-6789");
    expect(serialized).not.toContain("sender@example.com");
    expect(serialized).not.toContain("postgres://example");
  });

  it("carries an own __proto__ key through as data", () => {
    // A webhook body is parsed JSON, which is where an own `__proto__` key
    // comes from. Assigning it would reach Object.prototype's setter: the key
    // would vanish from the answer and the answer's own prototype would become
    // whatever the payload nested under it.
    const payload = JSON.parse('{"__proto__": {"polluted": true}, "id": "a"}');

    const redacted = redactSensitiveData(payload);

    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
    expect(
      (Object.prototype as Record<string, unknown>).polluted
    ).toBeUndefined();
    // Read back through JSON, because an object literal spelling `__proto__`
    // in the expectation would set a prototype rather than an own key.
    expect(JSON.parse(JSON.stringify(redacted))).toEqual(
      JSON.parse('{"__proto__": {"polluted": true}, "id": "a"}')
    );
  });
});

describe("redactSensitiveText", () => {
  it("scrubs bearer tokens, labeled secrets, and URI passwords", () => {
    const message =
      'Authorization: Bearer header.payload.signature; backupAuthorization: Basic dXNlcjpwYXNz; token="resume-secret"; {"apiToken":"api-secret","clientSecret":"client-secret","passwordHash":"hash-secret"}; postgres://user:db-password@host/db';

    const redacted = redactSensitiveText(message);

    expect(redacted).not.toContain("header.payload.signature");
    expect(redacted).not.toContain("resume-secret");
    expect(redacted).not.toContain("api-secret");
    expect(redacted).not.toContain("client-secret");
    expect(redacted).not.toContain("hash-secret");
    expect(redacted).not.toContain("dXNlcjpwYXNz");
    expect(redacted).not.toContain("db-password");
    expect(redacted).toContain("[REDACTED]");
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

  it("redacts every open graph area while preserving structural fields", () => {
    const graph = createSerializedWorkflowGraph({
      attributes: { credentials: { token: "graph-secret" } },
      nodes: [
        {
          id: "key",
          type: "action",
          position: { x: 10, y: 20 },
          width: 101,
          height: 102,
          measured: { width: 103, height: 104 },
          parentId: "parent",
          data: {
            label: "Act",
            type: "action",
            config: { credentials: { password: "node-secret" } },
          },
        },
        {
          id: "parent",
          type: "group",
          position: { x: 0, y: 0 },
          data: { label: "Group", type: "group" },
        },
      ],
      edges: [
        {
          id: "key",
          source: "parent",
          target: "key",
          sourceHandle: "source",
          targetHandle: "target",
          data: { label: "continue" },
        },
      ],
    });
    const graphWithOpenAttributes = {
      ...graph,
      attributes: {
        ...graph.attributes,
        credentials: { token: "graph-secret" },
      },
      nodes: graph.nodes.map((candidate) =>
        candidate.key === "key"
          ? {
              ...candidate,
              attributes: {
                ...candidate.attributes,
                dimensions: {
                  width: 105,
                  height: 106,
                  token: "dimension-secret",
                },
                measured: {
                  width: 103,
                  height: 104,
                  token: "measured-secret",
                },
                credentials: { password: "node-attribute-secret" },
              },
            }
          : candidate
      ),
      edges: graph.edges.map((candidate) =>
        candidate.key === "key"
          ? {
              ...candidate,
              attributes: {
                ...candidate.attributes,
                credentials: { token: "edge-secret" },
              },
            }
          : candidate
      ),
    };

    const redacted = redactWorkflowGraph(graphWithOpenAttributes);
    const redactedNode = redacted.nodes.find(
      (candidate) => candidate.key === "key"
    );
    const redactedEdge = redacted.edges.find(
      (candidate) => candidate.key === "key"
    );

    expect(redacted.attributes).toEqual({
      credentials: "[REDACTED]",
    });
    expect(redactedNode?.attributes.credentials).toBe("[REDACTED]");
    expect(redactedEdge?.attributes.credentials).toBe("[REDACTED]");
    expect(redactedNode?.attributes.data.config).toEqual({
      credentials: "[REDACTED]",
    });
    expect(redactedNode).toMatchObject({
      key: "key",
      attributes: {
        id: "key",
        type: "action",
        position: { x: 10, y: 20 },
        width: 101,
        height: 102,
        measured: { width: 103, height: 104, token: "********cret" },
        dimensions: { width: 105, height: 106, token: "********cret" },
        parentId: "parent",
      },
    });
    expect(redactedEdge).toMatchObject({
      key: "key",
      source: "parent",
      target: "key",
      attributes: {
        id: "key",
        source: "parent",
        target: "key",
        sourceHandle: "source",
        targetHandle: "target",
      },
    });
    expect(JSON.stringify(redacted)).not.toContain("secret");
  });
});
