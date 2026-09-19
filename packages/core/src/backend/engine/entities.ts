/**
 * Host-owned Entity Eligibility as the workflow engine may use it.
 *
 * The port returns an optional Eligibility decision and only the Entity State
 * paths the current node references. The full State stays behind the adapter.
 */

import type { EntityEligibilityReason } from "@wfgraph/shared/lifecycle/execution-contracts";
import { Effect } from "effect";
import type { JsonObject } from "@wfgraph/shared/types/json";
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

export type ResolveEntityNodeInput = {
  entityType: string;
  entityId: string;
  nodeId: string;
  /** Present when this node is also an Entity Eligibility checkpoint. */
  condition?: string | undefined;
  eventName: string | null;
  /** Entity State paths this node's templates reference. */
  paths: readonly string[];
};

export type EntityTemplateContext = {
  sourceId: string;
  entityType: string;
  values: JsonObject;
};

export type EntityNodeResolution = {
  decision: EntityEligibilityDecision;
  /** Only explicitly referenced paths, keyed by their authored path. */
  values: JsonObject;
};

export type WorkflowEntities = {
  /** Resolves one current-state snapshot for node data and optional Eligibility. */
  resolveNode(
    input: ResolveEntityNodeInput
  ): Effect.Effect<EntityNodeResolution, EngineFailure>;
};

/** Empty surface for unguarded engine tests and runs. */
export const noWorkflowEntities: WorkflowEntities = {
  // A guarded run reaching this surface is a deployment/configuration defect.
  // Unguarded runs never call it.
  resolveNode: () =>
    Effect.fail(
      engineFailure(
        "defect",
        "No Entity resolver is available for this workflow run"
      )
    ),
};
