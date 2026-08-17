import { createStore } from "jotai";
import { describe, expect, it } from "vitest";
import {
  hasBlockingWorkflowIssuesAtom,
  sameIssues,
  summarizeNodeIssues,
  workflowIssuesAtom,
  workflowIssuesByNodeIdAtom,
} from "#src/lib/workflow-issues-store";
import { nodeIssueLabel } from "#src/components/flow-elements/node-issue-badge";
import type { WorkflowIssue } from "@wfgraph/shared/graph/workflow-issues";

function missingField(nodeId: string, fieldKey: string): WorkflowIssue {
  return {
    kind: "missing_required_field",
    severity: "blocking",
    nodeId,
    nodeLabel: nodeId,
    fieldKey,
    fieldLabel: fieldKey,
    message: `Node "${nodeId}" is missing required field "${fieldKey}"`,
  };
}

function brokenReference(nodeId: string): WorkflowIssue {
  return {
    kind: "broken_reference",
    severity: "warning",
    nodeId,
    nodeLabel: nodeId,
    fieldKey: "body",
    fieldLabel: "Body",
    referencedNodeId: "gone",
    displayText: "Gone.id",
    message: `Node "${nodeId}" references missing step in Body`,
  };
}

describe("workflowIssuesByNodeIdAtom", () => {
  it("gathers every issue under the node wearing it", () => {
    const store = createStore();
    store.set(workflowIssuesAtom, [
      missingField("a", "channel"),
      brokenReference("a"),
      missingField("b", "userId"),
    ]);

    const byNode = store.get(workflowIssuesByNodeIdAtom);

    expect(byNode.get("a")?.messages).toHaveLength(2);
    expect(byNode.get("a")?.severity).toBe("blocking");
    expect(byNode.get("b")?.messages).toHaveLength(1);
    expect(byNode.has("c")).toBe(false);
  });

  /**
   * The summary is what `displayNodesAtom` folds onto a node, so it has to be
   * the same object between collection passes. Rebuilt per read, a flagged card
   * would take fresh `data` on every frame of every drag and never bail out of
   * rendering.
   */
  it("hands back the same summary object until the issues change", () => {
    const store = createStore();
    store.set(workflowIssuesAtom, [missingField("a", "channel")]);

    const first = store.get(workflowIssuesByNodeIdAtom).get("a");
    const second = store.get(workflowIssuesByNodeIdAtom).get("a");
    expect(first).toBe(second);

    store.set(workflowIssuesAtom, [missingField("a", "userId")]);
    expect(store.get(workflowIssuesByNodeIdAtom).get("a")).not.toBe(first);
  });

  /**
   * Fixing one node changes the whole list, so every other node's summary would
   * be rebuilt with it. Each rebuilt summary misses the paint cache in
   * `displayNodesAtom` and re-renders a card that did not change.
   */
  it("keeps a node's summary when another node's issues change", () => {
    const store = createStore();
    store.set(workflowIssuesAtom, [
      missingField("a", "channel"),
      missingField("b", "userId"),
    ]);
    const untouched = store.get(workflowIssuesByNodeIdAtom).get("a");

    // Node "b" is fixed; node "a" is exactly as it was.
    store.set(workflowIssuesAtom, [missingField("a", "channel")]);

    expect(store.get(workflowIssuesByNodeIdAtom).get("a")).toBe(untouched);
    expect(store.get(workflowIssuesByNodeIdAtom).has("b")).toBe(false);
  });

  it("is empty for a clean graph, so no node data is rewritten", () => {
    const store = createStore();

    expect(store.get(workflowIssuesByNodeIdAtom).size).toBe(0);
    expect(store.get(hasBlockingWorkflowIssuesAtom)).toBe(false);
  });

  it("reports blocking only when something actually blocks", () => {
    const store = createStore();

    store.set(workflowIssuesAtom, [brokenReference("a")]);
    expect(store.get(hasBlockingWorkflowIssuesAtom)).toBe(false);

    store.set(workflowIssuesAtom, [
      brokenReference("a"),
      missingField("a", "x"),
    ]);
    expect(store.get(hasBlockingWorkflowIssuesAtom)).toBe(true);
  });
});

describe("sameIssues", () => {
  it("treats a recollected but identical list as unchanged", () => {
    // This is the ordinary case: the canvas settles, the collector runs again
    // over an unchanged graph, and answers with a fresh array saying the same
    // thing. Writing that would repaint every flagged card for nothing.
    expect(
      sameIssues([missingField("a", "channel")], [missingField("a", "channel")])
    ).toBe(true);
  });

  it("notices a different node, message, or count", () => {
    const base = [missingField("a", "channel")];

    expect(sameIssues(base, [missingField("b", "channel")])).toBe(false);
    expect(sameIssues(base, [missingField("a", "userId")])).toBe(false);
    expect(sameIssues(base, [...base, brokenReference("a")])).toBe(false);
    expect(sameIssues(base, [])).toBe(false);
  });

  it("notices a different kind on the same node", () => {
    // Severity travels with kind in the union, so this is also the only way the
    // severity of a node's answer can change without its message changing.
    expect(
      sameIssues([missingField("a", "channel")], [brokenReference("a")])
    ).toBe(false);
  });
});

describe("summarizeNodeIssues", () => {
  it("takes the worst severity on the node", () => {
    expect(
      summarizeNodeIssues([brokenReference("a"), missingField("a", "channel")])
        .severity
    ).toBe("blocking");
    expect(summarizeNodeIssues([brokenReference("a")]).severity).toBe(
      "warning"
    );
  });

  it("keeps every message, for the tooltip and the accessible name", () => {
    const summary = summarizeNodeIssues([
      missingField("a", "channel"),
      brokenReference("a"),
    ]);

    expect(summary.messages).toHaveLength(2);
    expect(nodeIssueLabel(summary)).toBe("2 blocking issues");
  });

  it("counts one issue in the singular, and says nothing when clean", () => {
    expect(nodeIssueLabel(summarizeNodeIssues([brokenReference("a")]))).toBe(
      "1 issue"
    );
    expect(nodeIssueLabel(undefined)).toBe("");
  });
});
