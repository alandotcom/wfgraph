import {
  type ActionMetadata,
  type EventMetadata,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { requireOutputFieldsFromSchema } from "@wfgraph/shared/graph/output-fields";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

// What a node offers downstream comes off the catalog the editor fetches once
// before render: an action's own entry, and for the entry node the Events its rules
// name. A case says what the surface holds by writing this object.
export type MutableCatalog = {
  events: EventMetadata[];
  actions: ActionMetadata[];
  integrations: ExtensionCatalog["integrations"];
};

export const surface: MutableCatalog = {
  events: [],
  actions: [],
  integrations: [],
};

/** One catalog action, with the fields a case cares about and defaults elsewhere. */
export function anAction(
  action: Partial<ActionMetadata> & { id: string }
): ActionMetadata {
  return {
    label: action.id,
    description: "",
    category: "Custom",
    configFields: [],
    outputFields: [],
    ...action,
  };
}

export function createNode(input: {
  id: string;
  type: "lifecycle" | "action";
  label: string;
  config?: Record<string, unknown>;
}): WorkflowNode {
  return {
    id: input.id,
    type: input.type,
    position: { x: 0, y: 0 },
    data: {
      label: input.label,
      type: input.type,
      config: input.config,
    },
  };
}

export function createEdge(input: {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
}): WorkflowEdge {
  return {
    id: input.id,
    source: input.source,
    target: input.target,
    ...(input.sourceHandle ? { sourceHandle: input.sourceHandle } : {}),
  };
}

/** One Event, its payload fields derived the way `defineEvent` derives them. */
export function anEvent(input: {
  name: string;
  schema: Parameters<typeof requireOutputFieldsFromSchema>[1];
}): EventMetadata {
  return {
    name: input.name,
    label: input.name,
    payloadFields: requireOutputFieldsFromSchema(
      `Event "${input.name}"`,
      input.schema
    ),
  };
}

/** The edge a run leaves the Started outlet by, drawn to one node. */
export function startedEdge(target: string): WorkflowEdge {
  return createEdge({
    id: `e-${target}`,
    source: "lifecycle-1",
    sourceHandle: LIFECYCLE_STARTED_HANDLE,
    target,
  });
}

/** An entry node whose rules start on these Events and cancel on those. */
export function anEntryNode(input: {
  startEvents?: string[];
  cancelEvents?: string[];
}): WorkflowNode {
  const lifecycleRules: LifecycleRules = {
    startEvents: input.startEvents ?? [],
    cancelEvents: input.cancelEvents ?? [],
    concurrency: "unlimited",
  };

  return createNode({
    id: "lifecycle-1",
    type: "lifecycle",
    label: "Lifecycle",
    config: { lifecycleRules },
  });
}
