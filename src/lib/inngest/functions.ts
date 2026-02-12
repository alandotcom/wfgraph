import { db } from "@/lib/db";
import { CURRENT_WORKFLOW_NAME } from "@/lib/workflow-constants";
import { createWorkflowRunRequestedFunction } from "./workflow-function";

const REGISTRY_CACHE_TTL_MS = 5000;

type WorkflowFunction = ReturnType<typeof createWorkflowRunRequestedFunction>;
type WorkflowDefinition = {
  id: string;
  name: string;
};

let cachedFunctions: WorkflowFunction[] = [];
let hasRegistryCache = false;
let cacheExpiresAt = 0;
let inflightRegistryBuild: Promise<WorkflowFunction[]> | null = null;

function toFunctionId(workflowId: string): string {
  return `workflow-${workflowId}`;
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

async function loadWorkflowFunctionsFromDb(): Promise<WorkflowFunction[]> {
  const workflowDefinitions = await db.query.workflows.findMany({
    columns: {
      id: true,
      name: true,
    },
  });

  return buildWorkflowFunctions(workflowDefinitions);
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
