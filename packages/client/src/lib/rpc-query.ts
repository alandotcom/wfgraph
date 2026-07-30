import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { QueryClient } from "@tanstack/react-query";
import { type Integration, rpc } from "#src/lib/rpc-client";

/**
 * TanStack Query bindings for the RPC contract.
 *
 * Query keys are derived from the contract path, so there is no key module to
 * keep in step with packages/shared/src/rpc/contracts.ts. Invalidating a whole
 * area is `orpcQuery.integration.key()`; invalidating one entry is
 * `orpcQuery.workflow.getById.queryKey({ input: { workflowId } })`.
 */
export const orpcQuery = createTanstackQueryUtils(rpc);

/**
 * Every connection the user has, in one cache entry.
 *
 * Deliberately unfiltered. A selector that wanted only Slack connections could
 * pass `{ type }` as input, but that would split the cache into one entry per
 * action type and refetch the same list once per kind of node on the canvas.
 * Consumers filter the one list themselves.
 */
export const integrationsQueryOptions = () =>
  orpcQuery.integration.getAll.queryOptions({ input: {} });

function toIntegrationIds(integrations: Integration[]): ReadonlySet<string> {
  return new Set(integrations.map((integration) => integration.id));
}

/** The value a node reads before the connection list has arrived. */
export const NO_INTEGRATION_IDS: ReadonlySet<string> = new Set();

/**
 * Just the ids, for the nodes on the canvas asking "does the connection I
 * point at still exist?".
 *
 * Every ActionNode subscribes to this, so identity matters: a module-level
 * select over structurally shared data hands back the same Set across a refetch
 * that changed nothing, and the canvas does not re-render.
 */
export const integrationIdsQueryOptions = () =>
  orpcQuery.integration.getAll.queryOptions({
    input: {},
    select: toIntegrationIds,
  });

/**
 * The workflow list, for the dashboard and the toolbar's switcher.
 *
 * The procedure answers summaries, so there is no graph to deserialise and no
 * select to memoise: both screens draw names.
 */
export const workflowListQueryOptions = () =>
  orpcQuery.workflow.getAll.queryOptions({ input: {} });

/*
 * What a write invalidates, said once.
 *
 * These are the only place in the client that names a workflow or integration
 * cache key for invalidation. A write that leaves the answer to its call site is
 * a write some call site will get wrong, which is how a deleted workflow stayed
 * on the dashboard for a full stale window.
 *
 * Each one takes procedure keys, never an area key like
 * `orpcQuery.workflow.key()`. The area also covers the editor's run queries:
 * `getExecutions` polls every two seconds while the runs panel is open, and
 * `getExecutionLogs` and `getExecutionEvents` poll alongside it while an
 * unfinished run is open. Widening the key turns one write into a burst.
 */

/** The workflow list, behind the dashboard table and the toolbar's switcher. */
export function refreshWorkflowList(queryClient: QueryClient) {
  return queryClient.invalidateQueries({
    queryKey: orpcQuery.workflow.getAll.key(),
  });
}

/**
 * Both views of run history: the editor's per-workflow payload, which carries the
 * Refused Starts with it, and the dashboard's combined list. Starting, cancelling,
 * or deleting runs makes both wrong, and whichever one is not on screen is the one
 * that gets forgotten.
 */
export function refreshRunHistory(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: orpcQuery.workflow.getExecutions.key(),
    }),
    queryClient.invalidateQueries({
      queryKey: orpcQuery.workflow.getExecutionsGlobal.key(),
    }),
  ]);
}

/** The connection list, which every selector and every node reads. */
export function refreshIntegrations(queryClient: QueryClient) {
  return queryClient.invalidateQueries({
    queryKey: orpcQuery.integration.getAll.key(),
  });
}
