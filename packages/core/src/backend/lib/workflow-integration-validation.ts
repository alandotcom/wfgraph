import { uniq } from "es-toolkit/array";
import {
  getIntegrationTypesByIds as getIntegrationTypesByIdsInDb,
  validateIntegrationIds as validateIntegrationIdsInDb,
} from "@/backend/lib/db/integrations";
import { getAppLogger } from "@/backend/lib/logger";
import { findActionById } from "@/plugins/registry";
import {
  type IntegrationType,
  isIntegrationType,
} from "@/shared/types/integration";
import { SYSTEM_ACTION_INTEGRATIONS } from "@/shared/workflow/system-action-integrations";
import type { WorkflowNode } from "@/shared/workflow/types";

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

type IntegrationTypeMap = Record<string, IntegrationType>;

export type ValidateIntegrationIds = (
  integrationIds: string[]
) => Promise<ValidationResult>;

export type GetIntegrationTypesByIds = (
  integrationIds: string[]
) => Promise<IntegrationTypeMap>;

type IntegrationRequirement = {
  integrationId: string;
  requiredType: IntegrationType;
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
): IntegrationType | undefined {
  const action = resolveActionByType(actionType);
  if (isIntegrationType(action?.integration)) {
    return action.integration;
  }

  return SYSTEM_ACTION_INTEGRATIONS[actionType];
}

function extractRequiredIntegrationRequirements(
  nodes: WorkflowNode[],
  resolveActionByType: ResolveActionByType = (actionType) =>
    findActionById(actionType)
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
    findActionById(actionType)
): string[] {
  return uniq(
    extractRequiredIntegrationRequirements(nodes, resolveActionByType).map(
      (requirement) => requirement.integrationId
    )
  );
}

async function findTypeMismatchIntegrationIds(input: {
  requirements: IntegrationRequirement[];
  getIntegrationTypesByIds: GetIntegrationTypesByIds;
}): Promise<string[]> {
  const { requirements, getIntegrationTypesByIds } = input;
  if (requirements.length === 0) {
    return [];
  }

  const integrationTypeById = await getIntegrationTypesByIds(
    uniq(requirements.map((requirement) => requirement.integrationId))
  );
  const mismatchedIds = new Set<string>();

  for (const requirement of requirements) {
    const actualType = integrationTypeById[requirement.integrationId];
    if (actualType && actualType !== requirement.requiredType) {
      mismatchedIds.add(requirement.integrationId);
    }
  }

  return Array.from(mismatchedIds);
}

export async function validateWorkflowIntegrations(
  nodes: WorkflowNode[],
  options: {
    resolveActionByType?: ResolveActionByType;
    validateIntegrationIds?: ValidateIntegrationIds;
    getIntegrationTypesByIds?: GetIntegrationTypesByIds;
    strictValidation?: boolean;
  } = {}
): Promise<ValidationResult> {
  const resolveActionByType =
    options.resolveActionByType ?? ((actionType) => findActionById(actionType));
  const validateIntegrationIds =
    options.validateIntegrationIds ?? validateIntegrationIdsInDb;
  const getIntegrationTypesByIds =
    options.getIntegrationTypesByIds ?? getIntegrationTypesByIdsInDb;
  const strictValidationEnabled = shouldEnforceStrictValidation(
    options.strictValidation
  );
  const requirements = extractRequiredIntegrationRequirements(
    nodes,
    resolveActionByType
  );
  const integrationIds = uniq(
    requirements.map((requirement) => requirement.integrationId)
  );

  const existenceValidation = await validateIntegrationIds(integrationIds);
  if (!existenceValidation.valid) {
    if (!strictValidationEnabled) {
      integrationValidationLogger.warn(
        "Bypassing invalid integration references because strict validation is disabled",
        {
          invalidIntegrationIds: existenceValidation.invalidIds ?? [],
          invalidCount: existenceValidation.invalidIds?.length ?? 0,
          strictValidationEnv: STRICT_VALIDATION_ENV,
        }
      );
      return { valid: true };
    }

    return existenceValidation;
  }

  const typeMismatchIds = await findTypeMismatchIntegrationIds({
    requirements,
    getIntegrationTypesByIds,
  });
  if (typeMismatchIds.length > 0) {
    if (!strictValidationEnabled) {
      integrationValidationLogger.warn(
        "Bypassing integration type mismatch because strict validation is disabled",
        {
          invalidIntegrationIds: typeMismatchIds,
          invalidCount: typeMismatchIds.length,
          strictValidationEnv: STRICT_VALIDATION_ENV,
        }
      );
      return { valid: true };
    }

    return {
      valid: false,
      invalidIds: typeMismatchIds,
    };
  }

  return { valid: true };
}
