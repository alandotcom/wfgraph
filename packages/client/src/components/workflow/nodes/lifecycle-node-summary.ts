import {
  type ExtensionCatalog,
  findEvent,
} from "@wfgraph/shared/extensions/catalog";
import {
  manualStartAllowed,
  readLifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
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
    return `On ${labels.join(", ")}`;
  }

  return manualStartAllowed(rules)
    ? "Manual runs only"
    : "Nothing starts this yet";
}
