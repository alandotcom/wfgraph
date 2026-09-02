import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { QueryClient } from "@tanstack/react-query";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { rpc } from "#src/lib/rpc-client";
import type { WorkflowApiPayload } from "@wfgraph/shared/graph/api-contracts";

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

/**
 * What a provider-backed config field can be filled with, asked of one
 * connection.
 *
 * The key derives from the contract path plus this input, so the connection and
 * the parameter values are already in it: picking a different template is a
 * different entry rather than a refetch of this one. Connection writes refresh
 * the affected integration's entries through `refreshIntegrations`; a manual
 * refresh is `refetch()` on the one entry. Never reach for
 * `orpcQuery.integration.key()` here -- that area covers `getAll`, which every
 * connection picker on the canvas reads.
 */
export const configOptionsQueryOptions = (input: {
  integrationId: string;
  provider: string;
  parameters?: Record<string, string>;
}) => orpcQuery.integration.configOptions.queryOptions({ input });

/**
 * The workflow list, for the dashboard and the toolbar's switcher.
 *
 * The procedure answers summaries, so there is no graph to deserialise and no
 * select to memoise: both screens draw names.
 */
export const workflowListQueryOptions = () =>
  orpcQuery.workflow.getAll.queryOptions({ input: {} });

/** Module-level select: TanStack memoises by identity. */
export function selectPublicationState(payload: WorkflowApiPayload): {
  isPublished: boolean;
  hasUnpublishedChanges: boolean;
  publishedVersionId?: string | undefined;
  publishedVersion?: number | undefined;
  publishedAt?: string | undefined;
} {
  return {
    isPublished: Boolean(payload.publishedVersionId),
    hasUnpublishedChanges: payload.hasUnpublishedChanges,
    publishedVersionId: payload.publishedVersionId,
    publishedVersion: payload.publishedVersion,
    publishedAt: payload.publishedAt,
  };
}

/**
 * The open workflow's publication state, for the status strip's badge.
 *
 * Both halves come off this one payload rather than one from here and one from
 * the workflow list, because `cacheWorkflowPublication` patches this entry on
 * every save and publish, and the list it used to read is only marked stale.
 *
 * Lives in the getById cache (server state), not in jotai. The loader seeds the
 * entry; save and publish patch it. `staleTime: Infinity` keeps the badge off
 * the network: neither field moves except when a write patches the cache.
 */
export function workflowPublicationQueryOptions(workflowId: string) {
  return orpcQuery.workflow.getById.queryOptions({
    input: { workflowId },
    select: selectPublicationState,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

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
 * The open workflow's own entry, re-read after publication moved elsewhere.
 *
 * The editor's draft is safe from this: the canvas graph is hydrated by the route loader and
 * lives in jotai afterwards, so the only thing reading this entry is the
 * publication badge's select, and what comes back is the version metadata the
 * next publish has to be reviewed against.
 */
export function refreshWorkflowPublication(
  queryClient: QueryClient,
  workflowId: string
) {
  return queryClient.invalidateQueries({
    queryKey: orpcQuery.workflow.getById.queryKey({ input: { workflowId } }),
  });
}

/** Version history and usage, refreshed after a publication. */
export function refreshWorkflowVersionHistory(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: orpcQuery.workflow.getVersionHistory.key(),
    }),
    queryClient.invalidateQueries({
      queryKey: orpcQuery.workflow.getVersionUsage.key(),
    }),
  ]);
}

/**
 * Write the publication flag a write just settled into the open workflow's
 * getById entry. A save or a publish answers with the version fields beside it;
 * a publish refused because the draft is already the published graph carries
 * the flag alone, and that refusal writes it here too. The list procedure does
 * not carry this field (no draft graph), so the badge reads getById and nowhere
 * else.
 */
export function cacheWorkflowPublication(
  queryClient: QueryClient,
  // Each version field may be absent or set to undefined. A publish returns
  // all four; a refused publish returns `hasUnpublishedChanges` alone.
  workflow: Pick<WorkflowApiPayload, "id" | "hasUnpublishedChanges"> & {
    publishedVersionId?: string | undefined;
    publishedVersion?: number | undefined;
    publishedAt?: string | undefined;
    updatedAt?: string | undefined;
  }
) {
  queryClient.setQueryData(
    orpcQuery.workflow.getById.queryKey({
      input: { workflowId: workflow.id },
    }),
    (current: WorkflowApiPayload | undefined) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        hasUnpublishedChanges: workflow.hasUnpublishedChanges,
        updatedAt: workflow.updatedAt ?? current.updatedAt,
        ...omitUndefined({
          publishedVersionId: workflow.publishedVersionId,
          publishedVersion: workflow.publishedVersion,
          publishedAt: workflow.publishedAt,
        }),
      };
    }
  );
}

/** Replace the open workflow's exact getById response after a restore. */
export function cacheWorkflow(
  queryClient: QueryClient,
  workflow: WorkflowApiPayload
) {
  queryClient.setQueryData(
    orpcQuery.workflow.getById.queryKey({
      input: { workflowId: workflow.id },
    }),
    workflow
  );
}

/**
 * Both views of run history, version usage, and the open run's detail.
 *
 * Starting, cancelling, or deleting a run makes the lists wrong. Cancelling also
 * stops the open-run poll: that interval is derived from the list row, so a list
 * refetch that lands first would freeze the journey and waits on the last in-flight
 * snapshot unless those keys are marked here too.
 */
export function refreshRunHistory(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: orpcQuery.workflow.getExecutions.key(),
    }),
    queryClient.invalidateQueries({
      queryKey: orpcQuery.workflow.getExecutionsGlobal.key(),
    }),
    queryClient.invalidateQueries({
      queryKey: orpcQuery.workflow.getExecutionLogs.key(),
    }),
    queryClient.invalidateQueries({
      queryKey: orpcQuery.workflow.getExecutionEvents.key(),
    }),
    queryClient.invalidateQueries({
      queryKey: orpcQuery.workflow.getExecutionStatus.key(),
    }),
    queryClient.invalidateQueries({
      queryKey: orpcQuery.workflow.getVersionUsage.key(),
    }),
  ]);
}

/**
 * The connection list and, when known, one connection's provider options.
 *
 * Only the list is awaited. `invalidateQueries` settles when every active
 * matching query has refetched, and a `configOptions` refetch is a round trip
 * through the third party: with a node config panel open behind the dialog,
 * awaiting it would hold the overlay's close and its success toast open for as
 * long as the provider takes. The panel repaints when its own refetch lands.
 */
export function refreshIntegrations(
  queryClient: QueryClient,
  integrationId?: string
) {
  const list = queryClient.invalidateQueries({
    queryKey: orpcQuery.integration.getAll.key(),
  });

  if (integrationId) {
    void queryClient.invalidateQueries({
      queryKey: orpcQuery.integration.configOptions.key({
        input: { integrationId },
      }),
    });
  }

  return list;
}
