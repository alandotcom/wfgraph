import { describe, expect, it } from "vitest";
import { eventSplitOutlet } from "@wfgraph/shared/lifecycle/event-split";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  eventSplitConnections,
  eventSplitOwner,
  ownersPhrase,
} from "./event-split-reveal-summary";

const catalog = {
  actions: [],
  entities: [],
  integrations: [],
  events: [
    { name: "app/created", label: "Created", payloadFields: [] },
    { name: "app/canceled", label: "Canceled", payloadFields: [] },
  ],
} as const;

const node = (id: string, label: string): WorkflowNode => ({
  id,
  type: "action",
  position: { x: 0, y: 0 },
  data: { label, type: "action", config: {} },
});

const nodes = [node("split", "Split"), node("a", "Send"), node("b", "Log")];

describe("eventSplitConnections", () => {
  it("shows a reachable Event's label and destination", () => {
    const edges: WorkflowEdge[] = [
      {
        id: "e1",
        source: "split",
        target: "a",
        sourceHandle: eventSplitOutlet("app/created"),
      },
    ];
    expect(
      eventSplitConnections({
        nodeId: "split",
        reachableEventNames: ["app/created"],
        nodes,
        edges,
        catalog,
      }).rows
    ).toEqual([
      {
        eventName: "app/created",
        label: "Created",
        reachable: true,
        targets: [{ edgeId: "e1", nodeId: "a", label: "Send" }],
      },
    ]);
  });

  it("leaves a disconnected outlet with no targets", () => {
    expect(
      eventSplitConnections({
        nodeId: "split",
        reachableEventNames: ["app/created"],
        nodes,
        edges: [],
        catalog,
      }).rows
    ).toEqual([
      {
        eventName: "app/created",
        label: "Created",
        reachable: true,
        targets: [],
      },
    ]);
  });

  it("lists every reachable Event, in the order the reachable set names them", () => {
    const { rows } = eventSplitConnections({
      nodeId: "split",
      reachableEventNames: ["app/created", "app/canceled"],
      nodes,
      edges: [],
      catalog,
    });
    expect(rows.map((row) => row.eventName)).toEqual([
      "app/created",
      "app/canceled",
    ]);
  });

  it("adds a stale outlet a stored edge still names past the reachable set, marked unreachable", () => {
    const edges: WorkflowEdge[] = [
      {
        id: "e1",
        source: "split",
        target: "b",
        sourceHandle: eventSplitOutlet("app/retired"),
      },
    ];
    expect(
      eventSplitConnections({
        nodeId: "split",
        reachableEventNames: ["app/created"],
        nodes,
        edges,
        catalog,
      }).rows
    ).toEqual([
      {
        eventName: "app/created",
        label: "Created",
        reachable: true,
        targets: [],
      },
      {
        eventName: "app/retired",
        label: null,
        reachable: false,
        targets: [{ edgeId: "e1", nodeId: "b", label: "Log" }],
      },
    ]);
  });

  it("lists an edge that leaves by no named outlet apart from the rows, and ignores one to a missing node", () => {
    const edges: WorkflowEdge[] = [
      { id: "e1", source: "split", target: "a", sourceHandle: null },
      {
        id: "e2",
        source: "split",
        target: "gone",
        sourceHandle: eventSplitOutlet("app/created"),
      },
    ];
    expect(
      eventSplitConnections({
        nodeId: "split",
        reachableEventNames: ["app/created"],
        nodes,
        edges,
        catalog,
      })
    ).toEqual({
      rows: [
        {
          eventName: "app/created",
          label: "Created",
          reachable: true,
          targets: [],
        },
      ],
      withoutOutlet: [{ edgeId: "e1", nodeId: "a", label: "Send" }],
    });
  });
});

describe("eventSplitOwner", () => {
  it("names the Lifecycle Node's Start Events or Cancel Events by side", () => {
    expect(
      eventSplitOwner({
        source: { kind: "lifecycle", nodeId: "lifecycle", side: "started" },
        nodes,
        catalog,
      })
    ).toMatchObject({
      description: "the Lifecycle Node's Start Events",
      actionLabel: "Open Lifecycle Start Events",
    });
    expect(
      eventSplitOwner({
        source: { kind: "lifecycle", nodeId: "lifecycle", side: "canceled" },
        nodes,
        catalog,
      })
    ).toMatchObject({
      description: "the Lifecycle Node's Cancel Events",
      actionLabel: "Open Lifecycle Cancel Events",
    });
  });

  it("names a Wait by its label", () => {
    const owner = eventSplitOwner({
      source: { kind: "wait", nodeId: "a" },
      nodes,
      catalog,
    });
    expect(owner.description).toBe("the Wait Subscriptions of Send");
    expect(owner.actionLabel).toBe("Open Send");
    expect(
      ownersPhrase([
        owner,
        eventSplitOwner({
          source: { kind: "lifecycle", nodeId: "lifecycle", side: "started" },
          nodes,
          catalog,
        }),
      ])
    ).toBe(
      "the Wait Subscriptions of Send and the Lifecycle Node's Start Events"
    );
  });
});
