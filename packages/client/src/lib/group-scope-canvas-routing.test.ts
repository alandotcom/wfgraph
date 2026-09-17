import { describe, expect, it } from "vitest";
import { Position } from "@xyflow/react";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import {
  isConditionActionType,
  normalizeConditionBranch,
} from "@wfgraph/shared/conditions/condition-branch";
import {
  getWorkflowEdgeDrawnPath,
  getWorkflowEdgePath,
} from "#src/components/flow-elements/edge-path";
import {
  boundaryStubId,
  focusedGroupCanvasGraph,
} from "#src/lib/group-scope-canvas";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { CONDITION_OUTLET_FRACTION } from "#src/lib/workflow-node-dimensions";

type Point = { x: number; y: number };

function step(id: string, actionType: string, parentId?: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: id, type: "action", config: { actionType } },
    ...(parentId ? { parentId } : {}),
  };
}

function edge(
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  const id = `${source}->${target}${sourceHandle ? `:${sourceHandle}` : ""}`;
  return sourceHandle
    ? { id, source, target, sourceHandle }
    : { id, source, target };
}

function frame(direction: "vertical" | "horizontal"): WorkflowNode {
  return {
    id: "lookups",
    type: "group",
    position: { x: 0, y: 0 },
    data: { label: "User lookups", type: "group", config: { direction } },
  };
}

const LIFECYCLE: WorkflowNode = {
  id: "life",
  type: "lifecycle",
  position: { x: 0, y: 0 },
  data: { label: "Lifecycle", type: "lifecycle" },
};

/**
 * The "User lookups" Group: the Lifecycle enters at Get User and Find open
 * issues, Get User feeds a new Action, Get User and the Action both continue to
 * Send Message outside, and Find open issues and a pasted copy of it end.
 */
function userLookups(direction: "vertical" | "horizontal") {
  return {
    nodes: [
      LIFECYCLE,
      frame(direction),
      step("getUser", "clerk/get-user", "lookups"),
      step("findOpen", "linear/find-issues", "lookups"),
      step("action", "", "lookups"),
      step("findCopy", "linear/find-issues", "lookups"),
      step("send", "mailer/send"),
    ],
    edges: [
      edge("life", "getUser", "started"),
      edge("life", "findOpen", "started"),
      edge("getUser", "action"),
      edge("getUser", "send"),
      edge("action", "send"),
    ],
  };
}

/**
 * The Group from the first report: the Lifecycle enters Get User and Find
 * Issues, and both continue to one outside Action.
 */
function sharedContinuation(direction: "vertical" | "horizontal") {
  return {
    nodes: [
      LIFECYCLE,
      frame(direction),
      step("getUser", "clerk/get-user", "lookups"),
      step("findIssues", "linear/find-issues", "lookups"),
      step("action", ""),
    ],
    edges: [
      edge("life", "getUser", "started"),
      edge("life", "findIssues", "started"),
      edge("getUser", "action"),
      edge("findIssues", "action"),
    ],
  };
}

/**
 * The Group from the second report: the Lifecycle enters five steps, Get User
 * feeds an Action, Get User and the Action both continue to Send Message
 * outside, and the other four steps end.
 */
function fiveEntries(direction: "vertical" | "horizontal") {
  return {
    nodes: [
      LIFECYCLE,
      frame(direction),
      step("getUser", "clerk/get-user", "lookups"),
      step("findOpen", "linear/find-issues", "lookups"),
      step("findIssues", "linear/find-issues", "lookups"),
      step("findMore", "linear/find-issues", "lookups"),
      step("createTicket", "linear/create-issue", "lookups"),
      step("action", "", "lookups"),
      step("send", "mailer/send"),
    ],
    edges: [
      edge("life", "getUser", "started"),
      edge("life", "findOpen", "started"),
      edge("life", "findIssues", "started"),
      edge("life", "findMore", "started"),
      edge("life", "createTicket", "started"),
      edge("getUser", "action"),
      edge("getUser", "send"),
      edge("action", "send"),
    ],
  };
}

/**
 * The Group from the third report: Get User feeds an Action that continues to
 * Send Message, Get User also continues there directly, and Find open issues
 * feeds a chain of two Actions whose path ends.
 */
function twoChains(direction: "vertical" | "horizontal") {
  return {
    nodes: [
      LIFECYCLE,
      frame(direction),
      step("getUser", "clerk/get-user", "lookups"),
      step("findOpen", "linear/find-issues", "lookups"),
      step("action", "", "lookups"),
      step("second", "", "lookups"),
      step("third", "", "lookups"),
      step("send", "mailer/send"),
    ],
    edges: [
      edge("life", "getUser", "started"),
      edge("life", "findOpen", "started"),
      edge("getUser", "action"),
      edge("action", "send"),
      edge("getUser", "send"),
      edge("findOpen", "second"),
      edge("second", "third"),
    ],
  };
}

/**
 * The Group from the fourth report: the Lifecycle enters Get User and Find
 * Issues, Get User feeds an Action whose path ends, and Get User and Find
 * Issues both continue to one outside Action.
 */
function endBesideContinuation(direction: "vertical" | "horizontal") {
  return {
    nodes: [
      LIFECYCLE,
      frame(direction),
      step("getUser", "clerk/get-user", "lookups"),
      step("findIssues", "linear/find-issues", "lookups"),
      step("action", "", "lookups"),
      step("next", ""),
    ],
    edges: [
      edge("life", "getUser", "started"),
      edge("life", "findIssues", "started"),
      edge("getUser", "action"),
      edge("getUser", "next"),
      edge("findIssues", "next"),
    ],
  };
}

/**
 * The Group from the fifth report: Get User and Find Issues each branch to
 * three new steps, and both continue to one outside Action.
 */
function twoFans(direction: "vertical" | "horizontal") {
  const children = ["getUser", "findIssues"].flatMap((source) =>
    [1, 2, 3].map((index) => `${source}${index}`)
  );
  return {
    nodes: [
      LIFECYCLE,
      frame(direction),
      step("getUser", "clerk/get-user", "lookups"),
      step("findIssues", "linear/find-issues", "lookups"),
      ...children.map((id) => step(id, "", "lookups")),
      step("next", ""),
    ],
    edges: [
      edge("life", "getUser", "started"),
      edge("life", "findIssues", "started"),
      // Children listed alternately, the order a person added them in.
      ...[1, 2, 3].flatMap((index) => [
        edge("getUser", `getUser${index}`),
        edge("findIssues", `findIssues${index}`),
      ]),
      edge("getUser", "next"),
      edge("findIssues", "next"),
    ],
  };
}

/**
 * The fifth report's Group after Add step after: each new step rejoins what its
 * source already reached, so every path leaves by the one outside Action.
 */
function twoFansRejoining(direction: "vertical" | "horizontal") {
  const shape = twoFans(direction);
  return {
    nodes: shape.nodes,
    edges: [
      ...shape.edges,
      ...["getUser", "findIssues"].flatMap((source) =>
        [1, 2, 3].map((index) => edge(`${source}${index}`, "next"))
      ),
    ],
  };
}

/**
 * The handle an edge leaves or enters on `node`, where the card and stub
 * components draw it: the middle of the outlet or inlet side, or for a
 * Condition's branch, where the card draws that branch.
 */
function handlePoint(
  node: WorkflowNode,
  side: "source" | "target",
  handle: string | null | undefined
): Point {
  const width = node.width ?? 0;
  const height = node.height ?? 0;
  const branch =
    side === "source" && isConditionActionType(node.data.config?.actionType)
      ? normalizeConditionBranch(handle)
      : null;
  const fraction =
    branch === "true" || branch === "false"
      ? CONDITION_OUTLET_FRACTION[branch]
      : 0.5;
  const vertical = node.sourcePosition === Position.Bottom;
  const { x, y } = node.position;
  if (vertical) {
    return { x: x + width * fraction, y: side === "source" ? y + height : y };
  }
  return { x: side === "source" ? x + width : x, y: y + height * fraction };
}

/** The corners of an edge's painted path, from source to target. */
function edgeCorners(
  graph: { nodes: WorkflowNode[] },
  painted: WorkflowEdge,
  options?: { drawnOnly: boolean }
): Point[] {
  const source = graph.nodes.find((node) => node.id === painted.source);
  const target = graph.nodes.find((node) => node.id === painted.target);
  if (!(source && target)) {
    throw new Error(`edge ${painted.id} has no painted end`);
  }
  const start = handlePoint(source, "source", painted.sourceHandle);
  const end = handlePoint(target, "target", null);
  const input = {
    sourceX: start.x,
    sourceY: start.y,
    sourcePosition: source.sourcePosition ?? Position.Bottom,
    targetX: end.x,
    targetY: end.y,
    targetPosition: target.targetPosition ?? Position.Top,
  };
  const route = {
    turnAlong: painted.data?.turnAlong,
    lane: painted.data?.lane,
    drawn: painted.data?.drawn,
  };
  const [fullPath] = getWorkflowEdgePath(input, route);
  const path = options?.drawnOnly
    ? (getWorkflowEdgeDrawnPath(input, route) ?? fullPath)
    : fullPath;
  // "M x y", "L x y" and the control point of each rounded corner "Q cx,cy ex,ey"
  // are the corners; the end point of a rounded corner lies on the next run,
  // unless the path ends with that corner.
  const corners: Point[] = [];
  const commands = [...path.matchAll(/([MLQ])\s*([^MLQ]*)/g)];
  commands.forEach(([, command, body], index) => {
    const [x = Number.NaN, y = Number.NaN, ex = Number.NaN, ey = Number.NaN] = (
      body ?? ""
    )
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (command) {
      corners.push({ x, y });
    }
    if (command === "Q" && index === commands.length - 1) {
      corners.push({ x: ex, y: ey });
    }
  });
  return corners;
}

type Run = { from: Point; to: Point; startsAt: number; length: number };

/** The straight runs of a path, each with its distance from the path's start. */
function runsOf(corners: readonly Point[]): Run[] {
  const runs: Run[] = [];
  let travelled = 0;
  corners.slice(1).forEach((to, index) => {
    const from = corners[index] ?? to;
    const length = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
    if (length > 0) {
      runs.push({ from, to, startsAt: travelled, length });
    }
    travelled += length;
  });
  return runs;
}

const EPSILON = 0.5;

/** How far a rounded corner reaches along each run beside it, as `edge-path` rounds it. */
const CORNER_LENGTH = 16;

/**
 * Every stretch two paths both draw, as distances along `a` from its start and
 * from its end.
 */
function sharedStretches(
  a: readonly Run[],
  b: readonly Run[]
): { fromStart: number; toStart: number }[] {
  const total = a.reduce((sum, run) => sum + run.length, 0);
  const stretches: { fromStart: number; toStart: number }[] = [];
  for (const runA of a) {
    for (const runB of b) {
      const vertical = (run: Run) => Math.abs(run.from.x - run.to.x) < EPSILON;
      const verticalA = vertical(runA);
      if (verticalA !== vertical(runB)) {
        continue;
      }
      const fixed = (run: Run) => (verticalA ? run.from.x : run.from.y);
      if (Math.abs(fixed(runA) - fixed(runB)) >= EPSILON) {
        continue;
      }
      const span = (run: Run) => {
        const [p, q] = verticalA
          ? [run.from.y, run.to.y]
          : [run.from.x, run.to.x];
        return [Math.min(p, q), Math.max(p, q)] as const;
      };
      const [lowA, highA] = span(runA);
      const [lowB, highB] = span(runB);
      const low = Math.max(lowA, lowB);
      const high = Math.min(highA, highB);
      if (high - low < EPSILON) {
        continue;
      }
      const origin = verticalA ? runA.from.y : runA.from.x;
      const [near, far] = [Math.abs(low - origin), Math.abs(high - origin)];
      stretches.push({
        fromStart: runA.startsAt + Math.min(near, far),
        toStart: runA.startsAt + Math.max(near, far),
      });
    }
  }
  return stretches.map((stretch) => ({
    fromStart: stretch.fromStart,
    toStart: Math.min(stretch.toStart, total),
  }));
}

/** How far two paths draw the same route from their starts. */
function commonLead(a: readonly Point[], b: readonly Point[]): number {
  const walk = (corners: readonly Point[]) => {
    const points: Point[] = [];
    runsOf(corners).forEach((run) => {
      const steps = Math.round(run.length);
      for (let index = 0; index < steps; index += 1) {
        const t = index / steps;
        points.push({
          x: run.from.x + (run.to.x - run.from.x) * t,
          y: run.from.y + (run.to.y - run.from.y) * t,
        });
      }
    });
    return points;
  };
  const [pointsA, pointsB] = [walk(a), walk(b)];
  let lead = 0;
  while (
    lead < pointsA.length &&
    lead < pointsB.length &&
    Math.abs((pointsA[lead]?.x ?? 0) - (pointsB[lead]?.x ?? 1)) < 1 &&
    Math.abs((pointsA[lead]?.y ?? 0) - (pointsB[lead]?.y ?? 1)) < 1
  ) {
    lead += 1;
  }
  return lead;
}

/**
 * Each pair of edges drawing over each other where they are not one fork. Two
 * edges from one outlet may share the route they both take from it, and two
 * edges into one inlet may share the route they both take into it; any other
 * shared stretch is reported.
 */
function overlaps(graph: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): string[] {
  const paths = graph.edges.map((painted) => ({
    painted,
    corners: edgeCorners(graph, painted),
  }));
  const found: string[] = [];
  paths.forEach((a, index) => {
    for (const b of paths.slice(index + 1)) {
      const sameSource =
        a.painted.source === b.painted.source &&
        (a.painted.sourceHandle ?? null) === (b.painted.sourceHandle ?? null);
      const sameTarget = a.painted.target === b.painted.target;
      const runsA = runsOf(a.corners);
      const total = runsA.reduce((sum, run) => sum + run.length, 0);
      const lead = sameSource ? commonLead(a.corners, b.corners) : 0;
      const tail = sameTarget
        ? commonLead(a.corners.toReversed(), b.corners.toReversed())
        : 0;
      const stray = sharedStretches(runsA, runsOf(b.corners)).filter(
        (stretch) =>
          stretch.toStart > lead + 1 &&
          stretch.fromStart < total - tail - 1 &&
          // Where a fork or a join parts, one path rounds its corner while the
          // other runs on, so they share the corner's own length and no more.
          stretch.toStart - stretch.fromStart > CORNER_LENGTH + EPSILON
      );
      if (stray.length > 0) {
        found.push(`${a.painted.id} and ${b.painted.id}`);
      }
    }
  });
  return found;
}

/**
 * Each edge with a run that passes through a card or a stub other than its own
 * ends, or runs closer than 10px beside one.
 */
function runsThroughCards(graph: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): string[] {
  const margin = 10;
  return graph.edges.flatMap((painted) => {
    const runs = runsOf(edgeCorners(graph, painted));
    return graph.nodes
      .filter(
        (node) => node.id !== painted.source && node.id !== painted.target
      )
      .filter((node) => {
        const left = node.position.x - margin;
        const right = node.position.x + (node.width ?? 0) + margin;
        const top = node.position.y - margin;
        const bottom = node.position.y + (node.height ?? 0) + margin;
        return runs.some(
          (run) =>
            Math.min(run.from.x, run.to.x) < right &&
            Math.max(run.from.x, run.to.x) > left &&
            Math.min(run.from.y, run.to.y) < bottom &&
            Math.max(run.from.y, run.to.y) > top
        );
      })
      .map((node) => `${painted.id} passes ${node.id.trim()}`);
  });
}

/**
 * Each pair of edges whose drawn paths draw the same stretch, longer than a
 * rounded corner, twice. A shared run drawn twice shows uneven dashes. Where
 * one path rounds a corner the other runs straight through, the two share that
 * corner's own length, which is not a run drawn twice.
 */
function drawnTwice(graph: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): string[] {
  const drawn = graph.edges.map((painted) => ({
    painted,
    runs: runsOf(edgeCorners(graph, painted, { drawnOnly: true })),
  }));
  return drawn.flatMap((a, index) =>
    drawn
      .slice(index + 1)
      .filter((b) =>
        sharedStretches(a.runs, b.runs).some(
          (stretch) =>
            stretch.toStart - stretch.fromStart > CORNER_LENGTH + EPSILON
        )
      )
      .map((b) => `${a.painted.id} and ${b.painted.id}`)
  );
}

/** The centre across the flow of a painted node. */
function centreAcross(
  graph: { nodes: WorkflowNode[] },
  id: string,
  direction: "vertical" | "horizontal"
): number {
  const node = graph.nodes.find((item) => item.id === id);
  if (!node) {
    throw new Error(`no painted node ${id}`);
  }
  return direction === "vertical"
    ? node.position.x + (node.width ?? 0) / 2
    : node.position.y + (node.height ?? 0) / 2;
}

/**
 * Each pair of edges whose runs cross: a run across the flow of one passing
 * through a run along the flow of the other away from both runs' ends.
 */
function crossings(graph: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): string[] {
  const paths = graph.edges.map((painted) => ({
    painted,
    runs: runsOf(edgeCorners(graph, painted)),
  }));
  const crosses = (a: Run, b: Run) => {
    const horizontal = (run: Run) => Math.abs(run.from.y - run.to.y) < EPSILON;
    if (horizontal(a) === horizontal(b)) {
      return false;
    }
    const [across, along] = horizontal(a) ? [a, b] : [b, a];
    const y = across.from.y;
    const x = along.from.x;
    const inside = (value: number, p: number, q: number) =>
      value > Math.min(p, q) + 1 && value < Math.max(p, q) - 1;
    return (
      inside(x, across.from.x, across.to.x) &&
      inside(y, along.from.y, along.to.y)
    );
  };
  return paths.flatMap((a, index) =>
    paths
      .slice(index + 1)
      .filter((b) =>
        a.runs.some((runA) => b.runs.some((runB) => crosses(runA, runB)))
      )
      .map((b) => `${a.painted.id} and ${b.painted.id}`)
  );
}

function paint(input: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }) {
  const graph = focusedGroupCanvasGraph({ ...input, groupId: "lookups" });
  if (!graph) {
    throw new Error("the Group was not found");
  }
  return graph;
}

describe("focused Group edge routing", () => {
  it.each(["vertical", "horizontal"] as const)(
    "draws no two %s User lookups edges over each other outside a fork",
    (direction) => {
      const graph = paint(userLookups(direction));
      expect(graph.edges).toHaveLength(7);
      expect(overlaps(graph)).toEqual([]);
    }
  );

  it.each([
    ["the Action ends", ["action->send"], []],
    [
      "the Action ends before the copy is pasted",
      ["action->send"],
      ["findCopy"],
    ],
    ["the copy is not pasted yet", [], ["findCopy"]],
    ["Get User does not continue yet", ["getUser->send"], []],
  ])(
    "draws no two edges over each other while authoring, when %s",
    (_name, droppedEdges, droppedNodes) => {
      for (const direction of ["vertical", "horizontal"] as const) {
        const shape = userLookups(direction);
        const graph = paint({
          nodes: shape.nodes.filter((node) => !droppedNodes.includes(node.id)),
          edges: shape.edges.filter((item) => !droppedEdges.includes(item.id)),
        });
        expect(overlaps(graph)).toEqual([]);
      }
    }
  );

  it("reports two edges that turn on one track toward each other's stubs", () => {
    const card = (id: string, x: number, y: number): WorkflowNode => ({
      ...step(id, "mailer/send"),
      position: { x, y },
      width: 192,
      height: 112,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    });
    const turn = (painted: WorkflowEdge): WorkflowEdge => ({
      ...painted,
      data: { turnAlong: 150 },
    });
    expect(
      overlaps({
        nodes: [
          card("a", 0, 0),
          card("b", 300, 0),
          card("c", 150, 200),
          card("d", 450, 200),
        ],
        edges: [turn(edge("a", "d")), turn(edge("b", "c"))],
      })
    ).toEqual(["a->d and b->c"]);
  });

  it("stands each bottom stub under the step that reaches it", () => {
    const graph = paint(userLookups("vertical"));
    const centreX = (id: string) => {
      const node = graph.nodes.find((item) => item.id === id);
      return (node?.position.x ?? Number.NaN) + (node?.width ?? 0) / 2;
    };
    const end = (nodeId: string) =>
      boundaryStubId("end", { nodeId, handle: null });
    expect(
      centreX(boundaryStubId("continuation", { nodeId: "send", handle: null }))
    ).toBe(centreX("getUser"));
    expect(centreX(end("findOpen"))).toBe(centreX("findOpen"));
    expect(centreX(end("findCopy"))).toBe(centreX("findCopy"));
  });

  it("keeps edges apart when a Condition's branches and a join cross one gap", () => {
    const shape = userLookups("vertical");
    const gate = step("gate", BUILT_IN_ACTION_IDS.condition, "lookups");
    const graph = paint({
      nodes: [
        ...shape.nodes,
        gate,
        step("left", "mailer/send", "lookups"),
        step("right", "mailer/send", "lookups"),
      ],
      edges: [
        ...shape.edges,
        edge("findOpen", "gate"),
        edge("gate", "left", "false"),
        edge("gate", "right", "true"),
        edge("findCopy", "left"),
        edge("action", "right"),
      ],
    });
    expect(overlaps(graph)).toEqual([]);
  });
  describe.each(["vertical", "horizontal"] as const)(
    "the reported Groups in a %s Group",
    (direction) => {
      const continuation = (nodeId: string) =>
        boundaryStubId("continuation", { nodeId, handle: null });

      it.each([
        ["two steps continuing to one Action", sharedContinuation],
        ["five entries with a shared continuation", fiveEntries],
        ["a direct continuation beside a chain", twoChains],
        ["a path end beside a shared continuation", endBesideContinuation],
        ["two fans rejoining one continuation", twoFansRejoining],
      ] as const)(
        "keeps edges off the cards and draws every shared run once for %s",
        (_name, shape) => {
          const graph = paint(shape(direction));
          expect(overlaps(graph)).toEqual([]);
          expect(runsThroughCards(graph)).toEqual([]);
          expect(drawnTwice(graph)).toEqual([]);
        }
      );

      it("draws one exit and no crossing edges once every fan rejoins it", () => {
        const graph = paint(twoFansRejoining(direction));
        expect(
          graph.nodes.filter((node) => node.type === "groupContinuation")
        ).toHaveLength(1);
        expect(graph.nodes.filter((node) => node.type === "groupEnd")).toEqual(
          []
        );
        expect(overlaps(graph)).toEqual([]);
        expect(runsThroughCards(graph)).toEqual([]);
        expect(crossings(graph)).toEqual([]);
      });

      it("keeps each source's children together and draws no crossing edges", () => {
        const graph = paint(twoFans(direction));
        const across = (id: string) => centreAcross(graph, id, direction);
        const getUserChildren = [1, 2, 3].map((index) =>
          across(`getUser${index}`)
        );
        const findChildren = [1, 2, 3].map((index) =>
          across(`findIssues${index}`)
        );
        expect(Math.max(...getUserChildren)).toBeLessThan(
          Math.min(...findChildren)
        );
        expect(overlaps(graph)).toEqual([]);
        expect(runsThroughCards(graph)).toEqual([]);
        expect(crossings(graph)).toEqual([]);
      });

      it("centres a stub several steps continue to across those steps", () => {
        const graph = paint(sharedContinuation(direction));
        const across = (id: string) => centreAcross(graph, id, direction);
        expect(across(continuation("action"))).toBe(
          (across("getUser") + across("findIssues")) / 2
        );
      });

      it("stands a path end level with its outlet beside a shared continuation centred across its sources", () => {
        const graph = paint(endBesideContinuation(direction));
        const across = (id: string) => centreAcross(graph, id, direction);
        expect(
          across(boundaryStubId("end", { nodeId: "action", handle: null }))
        ).toBe(across("action"));
        const centre = (across("getUser") + across("findIssues")) / 2;
        if (direction === "horizontal") {
          expect(across(continuation("next"))).toBe(centre);
        } else {
          // A card-wide stub centred there would overlap the "Path ends"
          // stub, so it stands as near the centre as that stub allows.
          expect(across(continuation("next"))).toBeGreaterThan(centre);
          expect(across(continuation("next"))).toBeLessThan(
            across("findIssues")
          );
        }
      });

      it("stands a step with one source in that source's column", () => {
        const five = paint(fiveEntries(direction));
        expect(centreAcross(five, "action", direction)).toBe(
          centreAcross(five, "getUser", direction)
        );
        expect(centreAcross(five, continuation("send"), direction)).toBe(
          centreAcross(five, "getUser", direction)
        );

        const chains = paint(twoChains(direction));
        const across = (id: string) => centreAcross(chains, id, direction);
        expect(across("action")).toBe(across("getUser"));
        expect(across("second")).toBe(across("findOpen"));
        expect(across("third")).toBe(across("second"));
        expect(across(continuation("send"))).toBe(across("getUser"));
      });

      it("sends a direct edge to a stub around the card in its column", () => {
        const graph = paint(twoChains(direction));
        const direct = graph.edges.find((item) => item.id === "getUser->send");
        const lane = direct?.data?.lane?.across;
        expect(lane).toEqual(expect.any(Number));
        const action = graph.nodes.find((item) => item.id === "action");
        const [low, high] =
          direction === "vertical"
            ? [action?.position.x ?? 0, (action?.position.x ?? 0) + 192]
            : [action?.position.y ?? 0, (action?.position.y ?? 0) + 112];
        expect((lane ?? low) < low || (lane ?? low) > high).toBe(true);
      });
    }
  );
});
