import { Effect } from "effect";
import { uniq } from "es-toolkit/array";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import { getAppLogger } from "#src/backend/lib/logger";
import {
  type ExtensionCatalog,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { readConfigTrimmedString } from "@wfgraph/shared/graph/node-config";
import { findUnconfiguredIntegrationNodes } from "@wfgraph/shared/graph/workflow-issues";

/** As much of a catalog entry as the checks below read. */
type ResolvedAction = {
  integration?: string;
};

type ResolveActionByType = (actionType: string) => ResolvedAction | undefined;

/**
 * Where an action's required integration comes from: the assembled catalog the
 * caller read off the `Extensions` service.
 */
function resolveFromCatalog(catalog: ExtensionCatalog): ResolveActionByType {
  return (actionType) => findAction(catalog, actionType);
}

type IntegrationTypeMap = Record<string, string>;

/**
 * `IntegrationRepo.typesByIds`, taken as a parameter.
 *
 * A parameter rather than an import, because this module sits in `backend/lib`
 * and the repository is a service above it. Each caller already holds the
 * repository the check should read through.
 */
export type GetIntegrationTypesByIds = (
  integrationIds: string[]
) => Effect.Effect<IntegrationTypeMap, DatabaseError>;

type IntegrationRequirement = {
  integrationId: string;
  requiredType: string;
};

/**
 * What `validateWorkflowIntegrations` answers: whether the graph's integration
 * references check out. A blank `integrationId` on an action that needs one is
 * an `unconfigured` refusal (InvalidInput upstream); a present id that is
 * absent or mistyped is `invalid_ids`.
 */
export type IntegrationValidation =
  | { valid: true }
  | { valid: false; reason: "unconfigured"; error: string }
  | { valid: false; reason: "invalid_ids"; invalidIds: string[] };

const integrationValidationLogger = getAppLogger("workflow", "integration");
const STRICT_VALIDATION_ENV = "WORKFLOW_STRICT_INTEGRATION_VALIDATION";

function shouldEnforceStrictValidation(
  strictValidationOverride?: boolean
): boolean {
  if (strictValidationOverride !== undefined) {
    return strictValidationOverride;
  }

  const configured = process.env[STRICT_VALIDATION_ENV]?.trim().toLowerCase();
  if (!configured) {
    return true;
  }

  return !["0", "false", "no", "off"].includes(configured);
}

function extractRequiredIntegrationRequirements(
  nodes: WorkflowNode[],
  resolveActionByType: ResolveActionByType
): IntegrationRequirement[] {
  const requirements: IntegrationRequirement[] = [];

  for (const node of nodes) {
    if (node.data.type !== "action" || node.data.enabled === false) {
      continue;
    }

    const actionType = readConfigTrimmedString(node.data.config, "actionType");
    // Which integration an action needs is the catalog's answer, the same for a
    // plugin action and a host's own.
    const requiredType = actionType
      ? resolveActionByType(actionType)?.integration
      : undefined;
    if (!(actionType && requiredType)) {
      continue;
    }

    const integrationId = readConfigTrimmedString(
      node.data.config,
      "integrationId"
    );
    if (!integrationId) {
      continue;
    }

    requirements.push({
      integrationId,
      requiredType,
    });
  }

  return requirements;
}

/**
 * The integration ids a graph's enabled action nodes name, deduplicated.
 *
 * Which of them an action actually needs is the catalog's answer, so a node
 * carrying a stale id for an action that needs no connection contributes none.
 */
export function extractRequiredIntegrationIds(
  nodes: WorkflowNode[],
  catalog: ExtensionCatalog
): string[] {
  return uniq(
    extractRequiredIntegrationRequirements(
      nodes,
      resolveFromCatalog(catalog)
    ).map((requirement) => requirement.integrationId)
  );
}

/**
 * The integrations a graph names, checked in one read.
 *
 * One query answers both questions the graph asks -- whether each integration
 * exists, and whether it is the type the action needs -- because an id absent from
 * the type map is an id no row carries. This runs once per subscribing workflow on
 * every delivered Event, so a second read of the same rows would be paid per
 * delivery.
 */
const findInvalidIntegrations = Effect.fn("findInvalidIntegrations")(
  function* (input: {
    requirements: IntegrationRequirement[];
    getIntegrationTypesByIds: GetIntegrationTypesByIds;
  }) {
    const { requirements, getIntegrationTypesByIds } = input;
    if (requirements.length === 0) {
      return { missingIds: [] as string[], mismatchedIds: [] as string[] };
    }

    const integrationTypeById = yield* getIntegrationTypesByIds(
      uniq(requirements.map((requirement) => requirement.integrationId))
    );
    const missingIds = new Set<string>();
    const mismatchedIds = new Set<string>();

    for (const requirement of requirements) {
      const actualType = integrationTypeById[requirement.integrationId];
      if (!actualType) {
        missingIds.add(requirement.integrationId);
        continue;
      }
      if (actualType !== requirement.requiredType) {
        mismatchedIds.add(requirement.integrationId);
      }
    }

    return {
      missingIds: Array.from(missingIds),
      mismatchedIds: Array.from(mismatchedIds),
    };
  }
);

export const validateWorkflowIntegrations = Effect.fn(
  "validateWorkflowIntegrations"
)(function* (
  nodes: WorkflowNode[],
  catalog: ExtensionCatalog,
  getIntegrationTypesByIds: GetIntegrationTypesByIds,
  options: { strictValidation?: boolean } = {}
) {
  const strictValidationEnabled = shouldEnforceStrictValidation(
    options.strictValidation
  );

  // A blank connection comes first: the builder has not picked one yet, which
  // is a different fix from an id that no longer exists.
  const unconfigured = findUnconfiguredIntegrationNodes({ nodes, catalog });
  if (unconfigured.length > 0) {
    if (!strictValidationEnabled) {
      integrationValidationLogger.warn(
        "Bypassing unconfigured integration references because strict validation is disabled",
        {
          unconfiguredCount: unconfigured.length,
          strictValidationEnv: STRICT_VALIDATION_ENV,
        }
      );
    } else {
      const first = unconfigured[0];
      const invalid: IntegrationValidation = {
        valid: false,
        reason: "unconfigured",
        error: `Node "${first.nodeLabel}" needs a ${first.integrationLabel} connection`,
      };
      return invalid;
    }
  }

  const requirements = extractRequiredIntegrationRequirements(
    nodes,
    resolveFromCatalog(catalog)
  );

  const { missingIds, mismatchedIds } = yield* findInvalidIntegrations({
    requirements,
    getIntegrationTypesByIds,
  });

  const valid: IntegrationValidation = { valid: true };

  if (missingIds.length === 0 && mismatchedIds.length === 0) {
    return valid;
  }

  if (!strictValidationEnabled) {
    integrationValidationLogger.warn(
      "Bypassing invalid integration references because strict validation is disabled",
      {
        invalidIntegrationIds: [...missingIds, ...mismatchedIds],
        missingCount: missingIds.length,
        mismatchedCount: mismatchedIds.length,
        strictValidationEnv: STRICT_VALIDATION_ENV,
      }
    );
    return valid;
  }

  // A missing integration comes first: an id nothing carries is a different fix
  // from an id carrying the wrong type, and naming both at once helps nobody.
  const invalid: IntegrationValidation = {
    valid: false,
    reason: "invalid_ids",
    invalidIds: missingIds.length > 0 ? missingIds : mismatchedIds,
  };
  return invalid;
});
