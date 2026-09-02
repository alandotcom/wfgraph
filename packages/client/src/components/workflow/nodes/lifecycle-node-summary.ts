import {
  type ExtensionCatalog,
  findEvent,
} from "@wfgraph/shared/extensions/catalog";
import {
  manualStartAllowed,
  readLifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { readStartFilter } from "@wfgraph/shared/lifecycle/start-filters";
import type { WorkflowNodeData } from "#src/lib/workflow-graph-types";

/** Returns the canvas summary for the sources that can start a workflow. */
export function getStartSummary(
  config: WorkflowNodeData["config"],
  catalog: ExtensionCatalog
): string {
  const rules = readLifecycleRules(config);

  if (rules?.startEvents.length) {
    const labels = rules.startEvents.map(
      (name) => findEvent(catalog, name)?.label ?? name
    );
    // A filtered Start Event says so on the card, because the difference it makes
    // is a run that never appears: a builder looking for one and finding nothing
    // needs the canvas to point at the filter rather than at the Event.
    const filtered = rules.startEvents.some((name) =>
      readStartFilter(rules, name)
    );
    return filtered
      ? `On ${labels.join(", ")}, filtered`
      : `On ${labels.join(", ")}`;
  }

  return manualStartAllowed(rules)
    ? "Manual runs only"
    : "Nothing starts this yet";
}
