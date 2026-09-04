import { ORPCError } from "@orpc/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import {
  useAbortableSubscription,
  useDocumentVisibility,
} from "#src/hooks/effects";
import { can } from "#src/lib/authorization";
import { getClientLogger } from "#src/lib/logger";
import {
  cacheWorkflowList,
  workflowListQueryOptions,
} from "#src/lib/rpc-query";
import { ApiError, rpc } from "#src/lib/rpc-client";

const logger = getClientLogger("workflow", "list-sync");
const PERMANENT_LIST_ERROR_CODES = new Set(["UNAUTHORIZED", "FORBIDDEN"]);

function isPermanentListError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 401 || error.status === 403;
  }
  return (
    error instanceof ORPCError && PERMANENT_LIST_ERROR_CODES.has(error.code)
  );
}

/** Keeps the shared workflow-list query cache current across browser routes. */
export function WorkflowListSync() {
  const queryClient = useQueryClient();
  const visibility = useDocumentVisibility();
  const canGetList = can(WfGraphOperations.workflowGetAll.id);
  const canSubscribe = can(WfGraphOperations.workflowSubscribeList.id);
  const listQuery = useQuery({
    ...workflowListQueryOptions(),
    enabled: canGetList,
  });

  useAbortableSubscription({
    key: visibility,
    enabled: canSubscribe && listQuery.isFetched && visibility === "visible",
    subscribe: (signal) =>
      rpc.workflow.subscribeList(
        {},
        {
          signal,
          context: {
            retry: Number.POSITIVE_INFINITY,
            shouldRetry: ({ error }) => !isPermanentListError(error),
          },
        }
      ),
    onValue: (workflows) => cacheWorkflowList(queryClient, workflows),
    onError: () => logger.warn("Workflow list subscription stopped"),
  });

  return null;
}
