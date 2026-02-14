import { getAppLogger } from "@/backend/lib/logger";
import { registerCustomWorkflowTriggers } from "@/backend/workflow-triggers";

const triggerBootstrapLogger = getAppLogger("workflow", "trigger-bootstrap");

let triggersInitialized = false;

export function initializeWorkflowTriggers(): void {
  if (triggersInitialized) {
    return;
  }

  registerCustomWorkflowTriggers();
  triggersInitialized = true;

  triggerBootstrapLogger.info("Workflow triggers initialized");
}
