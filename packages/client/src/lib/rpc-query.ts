import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { type Integration, rpc, toSavedWorkflows } from "@/lib/rpc-client";

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
 * The workflow list, shaped for the dashboard and the toolbar's switcher.
 *
 * `toSavedWorkflows` is passed by reference rather than wrapped in an arrow:
 * TanStack memoises a select by the function's identity, so an inline closure
 * would re-run the whole graph deserialisation on every render.
 */
export const workflowListQueryOptions = () =>
  orpcQuery.workflow.getAll.queryOptions({
    input: {},
    select: toSavedWorkflows,
  });
