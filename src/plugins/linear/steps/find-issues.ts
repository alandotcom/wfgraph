import {
  LinearClient,
  LinearDocument,
  LinearError,
  parseLinearError,
  type LinearErrorRaw,
} from "@linear/sdk";
import { fetchCredentials } from "@/backend/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/backend/lib/steps/step-handler";
import { getErrorMessage } from "@/shared/utils";
import type { LinearCredentials } from "../credentials";

type LinearIssue = {
  id: string;
  title: string;
  url: string;
  state: string;
  priority: number;
  assigneeId?: string;
};

type FindIssuesResult =
  | { success: true; data: { issues: LinearIssue[]; count: number } }
  | { success: false; error: { message: string } };

export type FindIssuesCoreInput = {
  linearAssigneeId?: string;
  linearTeamId?: string;
  linearStatus?: string;
  linearLabel?: string;
};

export type FindIssuesInput = StepInput &
  FindIssuesCoreInput & {
    integrationId?: string;
  };

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: FindIssuesCoreInput,
  credentials: LinearCredentials
): Promise<FindIssuesResult> {
  const apiKey = credentials.LINEAR_API_KEY;

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

    // Build filter object for Linear's GraphQL API
    const filter: LinearDocument.IssueFilter = {};

    if (input.linearAssigneeId) {
      filter.assignee = { id: { eq: input.linearAssigneeId } };
    }

    if (input.linearTeamId) {
      filter.team = { id: { eq: input.linearTeamId } };
    }

    if (input.linearStatus && input.linearStatus !== "any") {
      filter.state = { name: { eqIgnoreCase: input.linearStatus } };
    }

    if (input.linearLabel) {
      filter.labels = { name: { eqIgnoreCase: input.linearLabel } };
    }

    const issuesResult = await linearClient.issues({
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    });

    const mappedIssues: LinearIssue[] = await Promise.all(
      issuesResult.nodes.map(async (issue) => {
        const issueState = issue.state ? await issue.state : undefined;
        return {
          id: issue.id,
          title: issue.title,
          url: issue.url,
          state: issueState?.name || "Unknown",
          priority: issue.priority,
          assigneeId: issue.assigneeId || undefined,
        };
      })
    );

    return {
      success: true,
      data: {
        issues: mappedIssues,
        count: mappedIssues.length,
      },
    };
  } catch (error) {
    const linearError =
      error instanceof LinearError
        ? error
        : parseLinearError(error as LinearErrorRaw);

    return {
      success: false,
      error: {
        message: `Failed to find issues: ${linearError.errors?.[0]?.message || linearError.message || getErrorMessage(error)}`,
      },
    };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function findIssuesStep(
  input: FindIssuesInput
): Promise<FindIssuesResult> {
  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
findIssuesStep.maxRetries = 0;

export const _integrationType = "linear";
