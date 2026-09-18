import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { nodeLabel } from "@wfgraph/shared/graph/group-structure";
import {
  checkEach,
  matchesSelector,
  selectorName,
  type SemanticsContext,
} from "#src/agent/judges/semantics/context";

function groupFrames(context: SemanticsContext) {
  return context.document.nodes.filter((node) => isGroupNode(node));
}

/**
 * Each required Group must exist under its label, hold a step matching every
 * member selector, and hold exactly `memberCount` nodes when the scenario names
 * a count. A graph with several Groups under one label passes when any of them
 * does.
 */
function missingGroups(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.requiredGroups, (required) => {
    const frames = groupFrames(context).filter(
      (frame) => nodeLabel(frame) === required.label
    );
    if (frames.length === 0) {
      return `missing Group ${required.label}`;
    }
    const failures = frames.map((frame) => {
      const members = context.document.nodes.filter(
        (node) => node.parentId === frame.id
      );
      const absent = required.members.filter(
        (selector) =>
          !members.some((member) => matchesSelector(member, selector))
      );
      if (absent.length > 0) {
        return `Group ${required.label} does not contain ${absent.map(selectorName).join(", ")}`;
      }
      if (
        required.memberCount !== undefined &&
        members.length !== required.memberCount
      ) {
        return `Group ${required.label} holds ${members.length} steps, expected ${required.memberCount}`;
      }
      return undefined;
    });
    return failures.includes(undefined) ? undefined : failures[0];
  });
}

function presentForbiddenGroups(context: SemanticsContext): string[] {
  const labels = new Set(groupFrames(context).map((frame) => nodeLabel(frame)));
  return checkEach(context.input.expected.forbiddenGroups, (label) =>
    labels.has(label) ? `Group ${label} is still present` : undefined
  );
}

function wrongGroupCount(context: SemanticsContext): string[] {
  const expected = context.input.expected.exactGroupCount;
  const actual = groupFrames(context).length;
  return expected === undefined || expected === actual
    ? []
    : [`Expected exactly ${expected} Groups, found ${actual}`];
}

/** Runs the Group membership rules in rationale order. */
export function assessGroupSemantics(context: SemanticsContext): string[] {
  return [
    ...missingGroups(context),
    ...presentForbiddenGroups(context),
    ...wrongGroupCount(context),
  ];
}
