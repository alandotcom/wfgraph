/**
 * Generated workflows for the Group layout property. Each scenario builds one
 * ungrouped graph, the steps a valid Group around part of it holds, and the
 * outcome a correct run produces, derived from the scenario alone. Every record
 * step's marker is a template over earlier outputs, so a side effect's text
 * shows which inputs resolved.
 */

import * as fc from "fast-check";
import {
  condition,
  edge,
  lifecycle,
  record,
  wait,
  WAKE,
  type FixtureEdge,
  type FixtureGraph,
  type FixtureNode,
} from "#src/backend/testing/reliability/fixtures";

type WaitMode = "event" | "delay";

type GroupShape =
  /** A sequence of records and Waits between the prefix and the suffix. */
  | { kind: "chain"; steps: Array<"record" | WaitMode> }
  /**
   * Branches from the prefix, each an optional event Wait then a record. With
   * `sharedWake`, every waiting branch listens for the same wake Event.
   */
  | {
      kind: "fanout";
      branches: Array<{ waits: boolean; wakeRank: number }>;
      sharedWake: boolean;
    }
  /** A Condition whose other branch ends inside the Group. */
  | {
      kind: "condition";
      takesTrue: boolean;
      continueFrom: "branch" | "step";
      closedPathLength: number;
    }
  /** An optional Wait, a split, two record arms and the join that merges them. */
  | {
      kind: "join";
      waitBeforeSplit: "none" | WaitMode;
      armLengths: [number, number];
    };

export type GroupScenario = {
  shape: GroupShape;
  /** Whether the Group also holds the record that enters the shape. */
  groupPrefix: boolean;
  /** Whether the Group also holds the record the shape continues to. */
  groupSuffix: boolean;
  /** The durable write that fails once and is retried. */
  fault: "none" | "completion" | "settlement";
};

/** A wake Event and the payload marker the driver sends with it. */
type Wake = { event: string; marker: string };

/** One point where the run is parked and the driver sends a wake Event. */
type WakeStage = {
  openWaits: string[];
  sideEffectsBefore: string[];
  wake: Wake;
};

type BuiltGroupScenario = {
  graph: FixtureGraph;
  memberIds: string[];
  startMarker: string;
  stages: WakeStage[];
  expectedSideEffects: string[];
  /** Every node expected to write exactly one run-log row. */
  expectedLoggedNodeIds: string[];
  fault: GroupScenario["fault"];
};

/** `map`'s value for `key`, throwing with `what` when the builder never set one. */
function required<V>(map: ReadonlyMap<string, V>, key: string, what: string) {
  const value = map.get(key);
  if (value === undefined)
    throw new Error(`Group scenario has no ${what} for ${key}`);
  return value;
}

/**
 * Accumulates the ungrouped graph and, beside it, what a correct run of it
 * does: each record's resolved marker and each node the run reaches.
 */
class ScenarioBuilder {
  readonly nodes: FixtureNode[] = [lifecycle(["before-execution"])];
  readonly edges: FixtureEdge[] = [];
  readonly resolved = new Map<string, string>();
  readonly reached: string[] = ["entry"];
  readonly stages: WakeStage[] = [];
  /** The payload marker each event Wait is woken with, keyed by Wait id. */
  readonly wakeMarkers = new Map<string, string>();
  private wakeEvents = 0;

  /** Adds a record whose marker reads `source`'s marker and, if given, a Wait's payload. */
  record(input: {
    id: string;
    source: string;
    wakeSource?: string | undefined;
    reached: boolean;
  }) {
    const wakePart = input.wakeSource
      ? `+{{@${input.wakeSource}:${input.wakeSource}.payload.marker}}`
      : "";
    this.nodes.push(
      record(
        input.id,
        `${input.id}<{{@${input.source}:${input.source}.marker}}${wakePart}`
      )
    );
    const resolvedWake = input.wakeSource
      ? `+${required(this.wakeMarkers, input.wakeSource, "wake marker")}`
      : "";
    this.resolved.set(
      input.id,
      `${input.id}<${required(this.resolved, input.source, "resolved marker")}${resolvedWake}`
    );
    if (input.reached) this.reached.push(input.id);
  }

  /** Adds a one-second delay Wait. */
  delay(id: string) {
    this.nodes.push(wait(id, "delay", undefined, "1s"));
    this.reached.push(id);
  }

  /** The next unused wake Event, sent with a marker naming `waitId`. */
  nextWake(waitId: string): Wake {
    const event = WAKE[this.wakeEvents++];
    if (event === undefined) throw new Error("At most three wake Events");
    return { event, marker: `wake:${waitId}` };
  }

  /** Adds an event Wait on `wake`, by default the next unused wake Event. */
  eventWait(id: string, wake: Wake = this.nextWake(id)): Wake {
    this.nodes.push(wait(id, "event", wake.event));
    this.wakeMarkers.set(id, wake.marker);
    this.reached.push(id);
    return wake;
  }

  connect(source: string, target: string, handle: string | null = null) {
    this.edges.push(edge(source, target, handle));
  }

  sideEffects(): string[] {
    return this.reached.flatMap((id) => {
      const marker = this.resolved.get(id);
      return marker === undefined ? [] : [marker];
    });
  }
}

type ShapeResult = {
  members: string[];
  /** The step the suffix follows, or null when every path ends in the shape. */
  exit: { source: string; handle: string | null } | null;
  /** The record and optional event Wait the suffix's marker reads. */
  suffixSources: { source: string; wakeSource?: string | undefined };
  suffixReached: boolean;
};

function buildChain(
  builder: ScenarioBuilder,
  steps: Array<"record" | WaitMode>
): ShapeResult {
  let previous = "prefix";
  let lastRecord = "prefix";
  let pendingWake: string | undefined;
  const members = steps.map((kind, index) => {
    const id = `chain_${index}`;
    if (kind === "record") {
      builder.record({
        id,
        source: lastRecord,
        wakeSource: pendingWake,
        reached: true,
      });
      lastRecord = id;
      pendingWake = undefined;
    } else {
      if (kind === "delay") {
        builder.delay(id);
      } else {
        builder.stages.push({
          openWaits: [id],
          sideEffectsBefore: builder.sideEffects(),
          wake: builder.eventWait(id),
        });
        pendingWake = id;
      }
    }
    builder.connect(previous, id);
    previous = id;
    return id;
  });
  return {
    members,
    exit: { source: previous, handle: null },
    suffixSources: { source: lastRecord, wakeSource: pendingWake },
    suffixReached: true,
  };
}

function buildFanout(
  builder: ScenarioBuilder,
  shape: Extract<GroupShape, { kind: "fanout" }>
): ShapeResult {
  const sharedWake = shape.sharedWake ? builder.nextWake("fan") : undefined;
  const wakes = new Map<string, Wake>();
  const members = shape.branches.flatMap((branch, index) => {
    const id = `fan_${index}`;
    if (!branch.waits) {
      builder.record({ id, source: "prefix", reached: true });
      builder.connect("prefix", id);
      return [id];
    }
    const waitId = `fan_wait_${index}`;
    wakes.set(
      waitId,
      builder.eventWait(waitId, sharedWake ?? builder.nextWake(waitId))
    );
    builder.connect("prefix", waitId);
    builder.record({
      id,
      source: "prefix",
      wakeSource: waitId,
      reached: false,
    });
    builder.connect(waitId, id);
    return [waitId, id];
  });

  // Every Wait parks before the first wake. A wake Event releases each open
  // Wait subscribed to it, so a shared wake releases every branch at once, and
  // otherwise each wake releases its own branch while the others stay open.
  const settled = [...builder.sideEffects()];
  const waiting = shape.branches
    .map((branch, index) => ({ ...branch, index }))
    .filter((branch) => branch.waits)
    .toSorted(
      (left, right) =>
        left.wakeRank - right.wakeRank || left.index - right.index
    );
  const release = (
    released: typeof waiting,
    openWaits: string[],
    wake: Wake
  ) => {
    builder.stages.push({ openWaits, sideEffectsBefore: [...settled], wake });
    for (const branch of released) {
      const branchRecord = `fan_${branch.index}`;
      builder.reached.push(branchRecord);
      settled.push(required(builder.resolved, branchRecord, "resolved marker"));
    }
  };
  const waitIds = waiting.map((branch) => `fan_wait_${branch.index}`);
  if (sharedWake !== undefined) {
    if (waiting.length > 0) release(waiting, waitIds, sharedWake);
  } else {
    waiting.forEach((branch, position) => {
      const waitId = `fan_wait_${branch.index}`;
      release(
        [branch],
        waitIds.slice(position),
        required(wakes, waitId, "wake Event")
      );
    });
  }
  return {
    members,
    exit: null,
    suffixSources: { source: "prefix" },
    suffixReached: false,
  };
}

function buildCondition(
  builder: ScenarioBuilder,
  shape: Extract<GroupShape, { kind: "condition" }>
): ShapeResult {
  builder.nodes.push(condition("gate", "prefix:go"));
  builder.reached.push("gate");
  builder.connect("prefix", "gate");
  const members = ["gate"];

  let previous = "gate";
  let handle: string | null = "false";
  for (let index = 0; index < shape.closedPathLength; index++) {
    const id = `closed_${index}`;
    builder.record({
      id,
      source: index === 0 ? "prefix" : previous,
      reached: !shape.takesTrue,
    });
    builder.connect(previous, id, handle);
    members.push(id);
    previous = id;
    handle = null;
  }

  if (shape.continueFrom === "branch") {
    return {
      members,
      exit: { source: "gate", handle: "true" },
      suffixSources: { source: "prefix" },
      suffixReached: shape.takesTrue,
    };
  }
  builder.record({ id: "open", source: "prefix", reached: shape.takesTrue });
  builder.connect("gate", "open", "true");
  members.push("open");
  return {
    members,
    exit: { source: "open", handle: null },
    suffixSources: { source: "open" },
    suffixReached: shape.takesTrue,
  };
}

function buildJoin(
  builder: ScenarioBuilder,
  shape: Extract<GroupShape, { kind: "join" }>
): ShapeResult {
  const members: string[] = [];
  let entry = "prefix";
  let wakeSource: string | undefined;
  if (shape.waitBeforeSplit === "delay") builder.delay("join_wait");
  if (shape.waitBeforeSplit === "event") {
    builder.stages.push({
      openWaits: ["join_wait"],
      sideEffectsBefore: builder.sideEffects(),
      wake: builder.eventWait("join_wait"),
    });
    wakeSource = "join_wait";
  }
  if (shape.waitBeforeSplit !== "none") {
    builder.connect("prefix", "join_wait");
    members.push("join_wait");
    entry = "join_wait";
  }
  builder.record({ id: "split", source: "prefix", wakeSource, reached: true });
  builder.connect(entry, "split");
  members.push("split");

  const armEnds = shape.armLengths.map((length, arm) => {
    let previous = "split";
    for (let index = 0; index < length; index++) {
      const id = `arm_${arm}_${index}`;
      builder.record({ id, source: previous, reached: true });
      builder.connect(previous, id);
      members.push(id);
      previous = id;
    }
    return previous;
  });
  const [left, right] = armEnds;
  if (left === undefined || right === undefined)
    throw new Error("Group scenario join has fewer than two arms");
  builder.nodes.push(
    record(
      "merge",
      `merge<{{@${left}:${left}.marker}}+{{@${right}:${right}.marker}}`
    )
  );
  builder.resolved.set(
    "merge",
    `merge<${required(builder.resolved, left, "resolved marker")}+${required(builder.resolved, right, "resolved marker")}`
  );
  builder.reached.push("merge");
  for (const end of armEnds) builder.connect(end, "merge");
  members.push("merge");
  return {
    members,
    exit: { source: "merge", handle: null },
    suffixSources: { source: "merge" },
    suffixReached: true,
  };
}

/** The ungrouped graph, the Group members and the expected run of `scenario`. */
export function buildGroupScenario(
  scenario: GroupScenario
): BuiltGroupScenario {
  const builder = new ScenarioBuilder();
  const { shape } = scenario;
  const startMarker =
    shape.kind === "condition" && !shape.takesTrue ? "stop" : "go";
  // The prefix copies the Start payload's marker into its own output. A
  // Condition reads a flat namespace in which a later step's `marker` replaces
  // the Start Event's, so the gate compares the prefix output.
  builder.nodes.push(record("prefix", "prefix:{{@entry:entry.marker}}"));
  builder.resolved.set("prefix", `prefix:${startMarker}`);
  builder.reached.push("prefix");
  builder.connect("entry", "prefix", "started");

  const result =
    shape.kind === "chain"
      ? buildChain(builder, shape.steps)
      : shape.kind === "fanout"
        ? buildFanout(builder, shape)
        : shape.kind === "condition"
          ? buildCondition(builder, shape)
          : buildJoin(builder, shape);

  const members = [
    ...(scenario.groupPrefix ? ["prefix"] : []),
    ...result.members,
  ];
  if (result.exit !== null) {
    builder.record({
      id: "suffix",
      ...result.suffixSources,
      reached: result.suffixReached,
    });
    builder.connect(result.exit.source, "suffix", result.exit.handle);
    if (scenario.groupSuffix) members.push("suffix");
  }

  const hasEventWake = builder.stages.length > 0;
  return {
    graph: { nodes: builder.nodes, edges: builder.edges },
    memberIds: members,
    startMarker,
    stages: builder.stages,
    expectedSideEffects: builder.sideEffects().toSorted(),
    expectedLoggedNodeIds: builder.reached.toSorted(),
    // Only a woken event Wait settles a wake claim; otherwise fail the completion write.
    fault:
      scenario.fault === "settlement" && !hasEventWake
        ? "completion"
        : scenario.fault,
  };
}

/** Chains keep at most three event Waits, because the fixture has three wake Events. */
function capEventWaits(steps: Array<"record" | WaitMode>) {
  let events = 0;
  return steps.map((step) =>
    step === "event" && ++events > 3 ? "delay" : step
  );
}

const groupShapes: fc.Arbitrary<GroupShape> = fc.oneof(
  fc
    .array(fc.constantFrom<"record" | WaitMode>("record", "event", "delay"), {
      minLength: 2,
      maxLength: 4,
    })
    .map((steps) => ({ kind: "chain" as const, steps: capEventWaits(steps) })),
  fc
    .record({
      branches: fc.array(
        fc.record({ waits: fc.boolean(), wakeRank: fc.nat(2) }),
        {
          minLength: 2,
          maxLength: 3,
        }
      ),
      sharedWake: fc.boolean(),
    })
    .map((fanout) => ({ kind: "fanout" as const, ...fanout })),
  fc.record({
    kind: fc.constant("condition" as const),
    takesTrue: fc.boolean(),
    continueFrom: fc.constantFrom<"branch" | "step">("branch", "step"),
    closedPathLength: fc.integer({ min: 1, max: 2 }),
  }),
  fc.record({
    kind: fc.constant("join" as const),
    waitBeforeSplit: fc.constantFrom<"none" | WaitMode>(
      "none",
      "event",
      "delay"
    ),
    armLengths: fc.tuple(
      fc.integer({ min: 1, max: 2 }),
      fc.integer({ min: 1, max: 2 })
    ),
  })
);

export const groupScenarios: fc.Arbitrary<GroupScenario> = fc.record({
  shape: groupShapes,
  groupPrefix: fc.boolean(),
  groupSuffix: fc.boolean(),
  fault: fc.constantFrom<GroupScenario["fault"]>(
    "none",
    "completion",
    "settlement"
  ),
});
