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
import { rpc } from "#src/lib/rpc-client";

const logger = getClientLogger("workflow", "list-sync");
/**
 * Keeps the shared workflow-list query cache current across browser routes.
 * `RetryLinkPlugin`'s default check ends the retries on a 4xx other than 408
 * and 429, so a refused subscription stops rather than reconnecting forever.
 */
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
          context: { retry: Number.POSITIVE_INFINITY },
        }
      ),
    onValue: (workflows) => cacheWorkflowList(queryClient, workflows),
    onError: () => logger.warn("Workflow list subscription stopped"),
  });

  return null;
}
