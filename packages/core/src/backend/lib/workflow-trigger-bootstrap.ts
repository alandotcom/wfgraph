import { getAppLogger } from "#src/backend/lib/logger";

const triggerBootstrapLogger = getAppLogger("workflow", "trigger-bootstrap");

let triggersInitialized = false;

export function initializeWorkflowTriggers(): void {
  if (triggersInitialized) {
    return;
  }

  triggersInitialized = true;

  triggerBootstrapLogger.info("Workflow triggers initialized");
}
