import { db } from "@/backend/lib/db";
import { CURRENT_WORKFLOW_NAME } from "@/backend/lib/workflow-constants";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lightweight extraction of the trigger node config from raw graph JSONB.
 *
 * This runs on every cache refresh (every 5s) for every workflow, so it
 * intentionally avoids full Zod validation and Graphology deserialization.
 * The raw JSONB shape is: { nodes: [{ attributes: { data: { type, config } } }] }.
 */
function findTriggerNodeConfig(
  graph: unknown
): Record<string, unknown> | undefined {
  if (!isRecord(graph)) {
    return;
  }

  const nodes = graph.nodes;
  if (!Array.isArray(nodes)) {
    return;
  }

  for (const node of nodes) {
    if (!isRecord(node)) {
      continue;
    }

    const attributes = node.attributes;
    if (!isRecord(attributes)) {
      continue;
    }

    const data = attributes.data;
    if (!isRecord(data)) {
      continue;
    }

    if (data.type === "trigger" && isRecord(data.config)) {
      return data.config;
    }
  }
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

  const { createInngestEventListenerFunction } = await import(
    "./event-listener-function"
  );

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
