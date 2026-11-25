/**
 * The starting moves of a workflow that holds nothing but its Lifecycle Node,
 * drawn on the canvas one rank below that card: choose what starts the
 * workflow, add a step, or describe it to the build agent when the host runs
 * one. It leaves once the workflow has a step, and a Start Event or schedule
 * takes its own move away.
 */

import { ViewportPortal } from "@xyflow/react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { Button } from "#src/components/ui/button";
import { useOpenLifecycleSection } from "#src/components/workflow/canvas-reveal/lifecycle-reveal-model";
import { openCommandPaletteAtom } from "#src/lib/command-palette-store";
import { isAgentEnabled } from "#src/lib/extensions";
import { nodesAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";
import { isAgentPanelOpenAtom } from "#src/lib/workflow-ui-store";
import {
  hasSchedule,
  readLifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";

/** How wide the block draws, wide enough for its longest button. */
const BLOCK_WIDTH = 240;

/**
 * Draws the starting moves while `nodes` is a lone Lifecycle Node. The caller
 * decides whether the canvas may add steps at all, which is Draft on the
 * overview at desktop widths.
 */
export function EmptyWorkflowStart() {
  const nodes = useAtomValue(nodesAtom);
  const [lifecycle, ...others] = nodes;
  if (
    lifecycle === undefined ||
    lifecycle.data.type !== "lifecycle" ||
    others.length > 0
  ) {
    return null;
  }
  return <StartingMoves lifecycle={lifecycle} />;
}

function StartingMoves({ lifecycle }: { lifecycle: WorkflowNode }) {
  const store = useStore();
  const openLifecycleSection = useOpenLifecycleSection(lifecycle.id);
  const setAgentPanelOpen = useSetAtom(isAgentPanelOpenAtom);
  const rules = readLifecycleRules(lifecycle.data.config);
  const hasStart = (rules?.startEvents.length ?? 0) > 0 || hasSchedule(rules);
  const x =
    lifecycle.position.x +
    (lifecycle.measured?.width ?? WORKFLOW_NODE_WIDTH) / 2 -
    BLOCK_WIDTH / 2;
  const y =
    lifecycle.position.y +
    (lifecycle.measured?.height ?? WORKFLOW_NODE_HEIGHT) +
    RANK_SPACING;

  return (
    <ViewportPortal>
      <section
        aria-label="Start this workflow"
        className="nodrag nopan pointer-events-auto absolute flex flex-col gap-2 rounded-lg border border-[var(--canvas-line)] border-dashed bg-background p-3 text-xs"
        style={{ transform: `translate(${x}px, ${y}px)`, width: BLOCK_WIDTH }}
      >
        <p className="text-muted-foreground">This workflow has no steps yet.</p>
        {hasStart ? null : (
          <Button
            onClick={() => openLifecycleSection("start-events")}
            size="sm"
            type="button"
            variant="outline"
          >
            Choose what starts it
          </Button>
        )}
        <Button
          onClick={() => store.set(openCommandPaletteAtom, { id: "add-step" })}
          size="sm"
          type="button"
          variant="outline"
        >
          Add step
        </Button>
        {isAgentEnabled() ? (
          <Button
            onClick={() => setAgentPanelOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            Describe it to the agent
          </Button>
        ) : null}
      </section>
    </ViewportPortal>
  );
}
