import {
  LinearClient,
  LinearError,
  type LinearErrorRaw,
  parseLinearError,
} from "@linear/sdk";
import { fetchCredentials } from "@/backend/lib/credential-fetcher";
import {
  type StepInput,
  withStepLogging,
} from "@/backend/lib/steps/step-handler";
import type { LinearCredentials } from "@/plugins/linear/credentials";
import { getErrorMessage } from "@/shared/utils";

type CreateTicketResult =
  | { success: true; data: { id: string; url: string; title: string } }
  | { success: false; error: { message: string } };

export type CreateTicketCoreInput = {
  ticketTitle: string;
  ticketDescription: string;
};

export type CreateTicketInput = StepInput &
  CreateTicketCoreInput & {
    integrationId?: string;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLinearErrorRaw(value: unknown): value is LinearErrorRaw {
  if (!isRecord(value)) {
    return false;
  }

  if (value.name !== undefined && typeof value.name !== "string") {
    return false;
  }

  if (value.message !== undefined && typeof value.message !== "string") {
    return false;
  }

  if (value.request !== undefined && !isRecord(value.request)) {
    return false;
  }

  if (value.response !== undefined && !isRecord(value.response)) {
    return false;
  }

  return true;
}

function toLinearError(error: unknown): LinearError {
  if (error instanceof LinearError) {
    return error;
  }

  if (isLinearErrorRaw(error)) {
    return parseLinearError(error);
  }

  if (error instanceof Error) {
    return parseLinearError({ name: error.name, message: error.message });
  }

  if (typeof error === "string") {
    return parseLinearError({ message: error });
  }

  return parseLinearError();
}

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: CreateTicketCoreInput,
  credentials: LinearCredentials
): Promise<CreateTicketResult> {
  const apiKey = credentials.LINEAR_API_KEY;
  const teamId = credentials.LINEAR_TEAM_ID;

  if (!apiKey) {
    return {
      success: false,
      error: {
        message:
          "LINEAR_API_KEY is not configured. Please add it in Project Integrations.",
      },
    };
  }

  try {
    const linearClient = new LinearClient({ apiKey });
    let targetTeamId = teamId;

    if (!targetTeamId) {
      const teamsResult = await linearClient.teams({
        first: 1,
      });
      const firstTeam = teamsResult.nodes[0];
      if (!firstTeam) {
        return {
          success: false,
          error: { message: "No teams found in Linear workspace" },
        };
      }
      targetTeamId = firstTeam.id;
    }

    const createResult = await linearClient.createIssue({
      title: input.ticketTitle,
      description: input.ticketDescription,
      teamId: targetTeamId,
    });

    const issue = createResult.issue ? await createResult.issue : undefined;
    if (!issue) {
      return {
        success: false,
        error: { message: "Failed to create issue" },
      };
    }

    return {
      success: true,
      data: {
        id: issue.id,
        url: issue.url,
        title: issue.title,
      },
    };
  } catch (error) {
    const linearError = toLinearError(error);

    return {
      success: false,
      error: {
        message: `Failed to create ticket: ${linearError.errors?.[0]?.message || linearError.message || getErrorMessage(error)}`,
      },
    };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function createTicketStep(
  input: CreateTicketInput
): Promise<CreateTicketResult> {
  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
createTicketStep.maxRetries = 0;

export const _integrationType = "linear";
