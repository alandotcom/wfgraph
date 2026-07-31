/**
 * Which Events a workflow's graph cares about, and in which role.
 *
 * The Inngest listener set is app-wide and comes from the catalog, so a
 * delivered Event needs an index to find its workflows rather than a scan of
 * every stored graph. These rows are that index: derived here from a graph the
 * save already validated, and written by the repository in the same transaction
 * as the graph itself.
 */

import type { WorkflowEventSubscriptionRow } from "#src/backend/services/workflows/repo";
import { BUILT_IN_ACTION_IDS } from "@rova/shared/actions/built-in-actions";
import { readLifecycleRules } from "@rova/shared/lifecycle/lifecycle-rules";
import type { WorkflowNode } from "@rova/shared/graph/types";
import { readWaitSubscriptions } from "@rova/shared/lifecycle/wait-subscription";

/**
 * The rows one graph's nodes call for, deduplicated by workflow, name and role.
 *
 * A Wait node subscribes on its own account, with no lifecycle role, which is
 * why a wait row exists beside the start and cancel ones: an Event that starts
 * no workflow still has to reach a run parked on it.
 */
export function deriveEventSubscriptions(input: {
  workflowId: string;
  nodes: readonly WorkflowNode[];
}): WorkflowEventSubscriptionRow[] {
  const rows = new Map<string, WorkflowEventSubscriptionRow>();
  // The builder's Correlation Path overrides, which sit on the entry node while
  // the wait rows come from nodes anywhere in the graph. Read before the walk so
  // node order cannot decide whether a wait row carries its path.
  const entryRules = input.nodes
    .filter((node) => node.data.type === "trigger")
    .map((node) => readLifecycleRules(node.data.config))
    .find((rules) => rules !== undefined);

  const add = (
    eventName: string,
    role: WorkflowEventSubscriptionRow["role"]
  ) => {
    // Keyed role-first, because a role is a closed union of three words while an
    // Event name is whatever a host wrote: keyed the other way round, two names
    // differing only in where a separator fell would collide.
    rows.set(`${role}:${eventName}`, {
      workflowId: input.workflowId,
      eventName,
      role,
      correlationPath: entryRules?.correlationPaths?.[eventName] ?? null,
    });
  };

  for (const node of input.nodes) {
    if (node.data.type === "trigger") {
      const rules = readLifecycleRules(node.data.config);
      if (rules?.startEvent) {
        add(rules.startEvent, "start");
      }
      for (const eventName of rules?.cancelEvents ?? []) {
        add(eventName, "cancel");
      }
      continue;
    }

    if (node.data.config?.actionType === BUILT_IN_ACTION_IDS.wait) {
      for (const subscription of readWaitSubscriptions(node.data.config)) {
        add(subscription.event, "wait");
      }
    }
  }

  return Array.from(rows.values());
}
