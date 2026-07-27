import { db } from "@/backend/lib/db";
import { CURRENT_WORKFLOW_NAME } from "@/backend/lib/workflow-constants";
import {
  serializedWorkflowGraphSchema,
  type WorkflowTriggerConfigInput,
} from "@/shared/workflow/schemas";
import type { InngestEventTriggerConfig } from "@/shared/workflow/trigger-registry";
import { resolveWorkflowTriggerDefinition } from "@/shared/workflow/trigger-registry";
import { createWorkflowRunRequestedFunction } from "./workflow-function";

const REGISTRY_CACHE_TTL_MS = 5000;

type WorkflowFunction = ReturnType<typeof createWorkflowRunRequestedFunction>;
type WorkflowDefinition = {
  id: string;
  name: string;
  graph: unknown;
};

type EventTriggerInfo = {
  workflowId: string;
  inngestEventTrigger: InngestEventTriggerConfig;
};

let cachedFunctions: WorkflowFunction[] = [];
let hasRegistryCache = false;
let cacheExpiresAt = 0;
let inflightRegistryBuild: Promise<WorkflowFunction[]> | null = null;

function toFunctionId(workflowId: string): string {
  return `workflow-${workflowId}`;
}

function toEventListenerFunctionId(workflowId: string): string {
  return `workflow-event-${workflowId}`;
}

/**
 * Pull the trigger node's config out of the graph JSONB stored on a workflow row.
 *
 * The column is untyped JSON, so the graph goes through its schema before it is
 * read. Failure is scoped to one workflow on purpose: a graph that does not parse
 * loses only its own event listener, and every other workflow still registers.
 * A throwing parse here would take the entire function registry down with one
 * malformed row.
 */
function findTriggerNodeConfig(
  graph: unknown
): WorkflowTriggerConfigInput | undefined {
  const parsedGraph = serializedWorkflowGraphSchema.safeParse(graph);
  if (!parsedGraph.success) {
    return undefined;
  }

  for (const node of parsedGraph.data.nodes) {
    const nodeData = node.attributes.data;
    if (nodeData.type === "trigger" && nodeData.config) {
      return nodeData.config;
    }
  }

  return undefined;
}

function findEventTriggers(
  workflows: WorkflowDefinition[]
): EventTriggerInfo[] {
  const triggers: EventTriggerInfo[] = [];
  for (const workflow of workflows) {
    const triggerConfig = findTriggerNodeConfig(workflow.graph);
    if (!triggerConfig) {
      continue;
    }

    const definition = resolveWorkflowTriggerDefinition(triggerConfig);
    if (
      definition.runtime.executionType === "event" &&
      definition.runtime.inngestEventTrigger
    ) {
      triggers.push({
        workflowId: workflow.id,
        inngestEventTrigger: definition.runtime.inngestEventTrigger,
      });
    }
  }
  return triggers;
}

export function buildWorkflowFunctions(
  workflowDefinitions: WorkflowDefinition[]
): WorkflowFunction[] {
  return workflowDefinitions
    .filter((workflow) => workflow.name !== CURRENT_WORKFLOW_NAME)
    .map((workflow) =>
      createWorkflowRunRequestedFunction({
        id: toFunctionId(workflow.id),
        name: workflow.name,
        workflowId: workflow.id,
      })
    );
}

async function buildEventListenerFunctions(
  eventTriggers: EventTriggerInfo[]
): Promise<WorkflowFunction[]> {
  if (eventTriggers.length === 0) {
    return [];
  }

  const { createInngestEventListenerFunction } =
    await import("./event-listener-function");

  return eventTriggers.map((trigger) =>
    createInngestEventListenerFunction({
      id: toEventListenerFunctionId(trigger.workflowId),
      workflowId: trigger.workflowId,
      inngestEventTrigger: trigger.inngestEventTrigger,
    })
  );
}

async function loadWorkflowFunctionsFromDb(): Promise<WorkflowFunction[]> {
  const workflowDefinitions = await db.query.workflows.findMany({
    columns: {
      id: true,
      name: true,
      graph: true,
    },
  });

  const savedWorkflows = workflowDefinitions.filter(
    (workflow) => workflow.name !== CURRENT_WORKFLOW_NAME
  );

  const runRequestedFunctions = buildWorkflowFunctions(savedWorkflows);
  const eventTriggers = findEventTriggers(savedWorkflows);
  const eventListenerFunctions =
    await buildEventListenerFunctions(eventTriggers);

  return [...runRequestedFunctions, ...eventListenerFunctions];
}

export async function getInngestFunctions(): Promise<WorkflowFunction[]> {
  const now = Date.now();
  if (hasRegistryCache && now < cacheExpiresAt) {
    return cachedFunctions;
  }

  if (inflightRegistryBuild) {
    return await inflightRegistryBuild;
  }

  inflightRegistryBuild = loadWorkflowFunctionsFromDb()
    .then((functions) => {
      cachedFunctions = functions;
      hasRegistryCache = true;
      cacheExpiresAt = Date.now() + REGISTRY_CACHE_TTL_MS;
      return functions;
    })
    .finally(() => {
      inflightRegistryBuild = null;
    });

  return await inflightRegistryBuild;
}

export function invalidateInngestFunctionsCache() {
  hasRegistryCache = false;
  cacheExpiresAt = 0;
}
