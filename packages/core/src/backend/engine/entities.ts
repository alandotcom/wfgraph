/**
 * Host-owned Entity Eligibility as the workflow engine may use it.
 *
 * The port returns only a decision. Entity State stays behind the adapter and
 * never crosses the durable runtime, store, node-output, or logging boundaries.
 */

import type { EntityEligibilityReason } from "@wfgraph/shared/lifecycle/execution-contracts";
import { Effect } from "effect";
import {
  type EngineFailure,
  engineFailure,
} from "#src/backend/engine/engine-failure";

export type EntityEligibilityDecision =
  | { outcome: "eligible" }
  | {
      outcome: "exit";
      reason: EntityEligibilityReason;
      checkedAt: string;
    };

export type EvaluateEntityEligibilityInput = {
  entityType: string;
  entityId: string;
  nodeId: string;
  condition: string;
  eventName: string | null;
};

export type WorkflowEntities = {
  /** Resolves current state and evaluates one authored Eligibility condition. */
  evaluateEligibility(
    input: EvaluateEntityEligibilityInput
  ): Effect.Effect<EntityEligibilityDecision, EngineFailure>;
};

/** Empty surface for unguarded engine tests and runs. */
export const noWorkflowEntities: WorkflowEntities = {
  // A guarded run reaching this surface is a deployment/configuration defect.
  // Unguarded runs never call it.
  evaluateEligibility: () =>
    Effect.fail(
      engineFailure(
        "defect",
        "No Entity resolver is available for this workflow run"
      )
    ),
};
