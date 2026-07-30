import { uniq } from "es-toolkit/array";
import { getIntegrationTypesByIds as getIntegrationTypesByIdsInDb } from "#src/backend/lib/db/integrations";
import { getAppLogger } from "#src/backend/lib/logger";
import { getExtensions } from "#src/backend/lib/extensions/current";
import { findAction } from "@rova/shared/extensions/catalog";
import { SYSTEM_ACTION_INTEGRATIONS } from "@rova/shared/workflow/system-action-integrations";
import type { WorkflowNode } from "@rova/shared/workflow/types";

type ResolvedAction = {
  integration?: unknown;
};

export type ResolveActionByType = (
  actionType: string
) => ResolvedAction | undefined;

type ValidationResult = {
  valid: boolean;
  invalidIds?: string[];
};

type IntegrationTypeMap = Record<string, string>;

export type GetIntegrationTypesByIds = (
  integrationIds: string[]
) => Promise<IntegrationTypeMap>;

type IntegrationRequirement = {
  integrationId: string;
  requiredType: string;
};

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

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value.trim() : undefined;
}

function getRequiredIntegrationType(
  actionType: string,
  resolveActionByType: ResolveActionByType
): string | undefined {
  const integration = resolveActionByType(actionType)?.integration;

  return typeof integration === "string" && integration
    ? integration
    : SYSTEM_ACTION_INTEGRATIONS[actionType];
}

function extractRequiredIntegrationRequirements(
  nodes: WorkflowNode[],
  resolveActionByType: ResolveActionByType = (actionType) =>
    findAction(getExtensions().catalog, actionType)
): IntegrationRequirement[] {
  const requirements: IntegrationRequirement[] = [];

  for (const node of nodes) {
    if (node.data.type !== "action" || node.data.enabled === false) {
      continue;
    }

    const actionType = readConfigString(node.data.config, "actionType");
    const requiredType = actionType
      ? getRequiredIntegrationType(actionType, resolveActionByType)
      : undefined;
    if (!(actionType && requiredType)) {
      continue;
    }

    const integrationId = readConfigString(node.data.config, "integrationId");
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

export function extractRequiredIntegrationIds(
  nodes: WorkflowNode[],
  resolveActionByType: ResolveActionByType = (actionType) =>
    findAction(getExtensions().catalog, actionType)
): string[] {
  return uniq(
    extractRequiredIntegrationRequirements(nodes, resolveActionByType).map(
      (requirement) => requirement.integrationId
    )
  );
}

/**
 * The integrations a graph names, checked in one read.
 *
 * One query answers both questions the graph asks -- whether each integration
 * exists, and whether it is the type the action needs -- because an id absent from
 * the type map is an id no row carries. It used to be two reads of the same rows
 * for different columns, on a path a delivered Event runs per subscribing
 * workflow.
 */
async function findInvalidIntegrations(input: {
  requirements: IntegrationRequirement[];
  getIntegrationTypesByIds: GetIntegrationTypesByIds;
}): Promise<{ missingIds: string[]; mismatchedIds: string[] }> {
  const { requirements, getIntegrationTypesByIds } = input;
  if (requirements.length === 0) {
    return { missingIds: [], mismatchedIds: [] };
  }

  const integrationTypeById = await getIntegrationTypesByIds(
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

export async function validateWorkflowIntegrations(
  nodes: WorkflowNode[],
  options: {
    resolveActionByType?: ResolveActionByType;
    getIntegrationTypesByIds?: GetIntegrationTypesByIds;
    strictValidation?: boolean;
  } = {}
): Promise<ValidationResult> {
  const resolveActionByType =
    options.resolveActionByType ??
    ((actionType: string) => findAction(getExtensions().catalog, actionType));
  const getIntegrationTypesByIds =
    options.getIntegrationTypesByIds ?? getIntegrationTypesByIdsInDb;
  const strictValidationEnabled = shouldEnforceStrictValidation(
    options.strictValidation
  );
  const requirements = extractRequiredIntegrationRequirements(
    nodes,
    resolveActionByType
  );

  const { missingIds, mismatchedIds } = await findInvalidIntegrations({
    requirements,
    getIntegrationTypesByIds,
  });

  if (missingIds.length === 0 && mismatchedIds.length === 0) {
    return { valid: true };
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
    return { valid: true };
  }

  // A missing integration comes first: an id nothing carries is a different fix
  // from an id carrying the wrong type, and naming both at once helps nobody.
  return {
    valid: false,
    invalidIds: missingIds.length > 0 ? missingIds : mismatchedIds,
  };
}
