import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * The client's cache of server state. It lives in its own module rather than in
 * main.tsx because the router's loaders prefetch through it, and a route file
 * cannot import the entry point.
 */

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: { errorMessage?: string };
    mutationMeta: {
      /** Toast this instead of whatever the server said. */
      errorMessage?: string;
      /**
       * Set when the call site shows the failure itself, inline or in a dialog.
       * A toast on top would say it twice.
       */
      errorShownByCaller?: true;
    };
  }
}

/**
 * What a failed mutation should say, or null to say nothing.
 *
 * A mutation is always something the user just did, so a failure surfaces
 * unless the call site has claimed it. Separated from the toast so the policy
 * can be read and tested without a DOM.
 */
export function mutationErrorToast(
  error: unknown,
  meta: { errorMessage?: string; errorShownByCaller?: true } | undefined
): string | null {
  if (meta?.errorShownByCaller) {
    return null;
  }

  return (
    meta?.errorMessage ??
    (error instanceof Error ? error.message : "Request failed")
  );
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    // A query that fails is worth a toast only when the user asked for the
    // thing that failed. Background reads that feed a panel say so in the
    // console and leave the screen alone, which is what the hand-written
    // try/catch blocks these queries replaced already did.
    onError: (error, query) => {
      const message = query.meta?.errorMessage;
      if (message) {
        toast.error(message);
      } else {
        console.error(query.queryHash, error);
      }
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      const message = mutationErrorToast(error, mutation.meta);
      if (message !== null) {
        toast.error(message);
      }
    },
  }),
  defaultOptions: {
    queries: {
      // An ApiError carries the HTTP status that produced it, and a 401 or a
      // 404 will not become a 200 on the third try. A polling query would also
      // stack retries on top of its own interval.
      retry: false,
      // In the editor a focus refetch would rehydrate the graph from the
      // server and throw away whatever the user had not saved yet. Anything
      // that needs to stay fresh says so with its own refetchInterval.
      refetchOnWindowFocus: false,
      // Connections and workflow lists are fetched once and read from cache
      // until something explicitly invalidates them; half a minute of
      // staleTime covers the gap without a manual version counter.
      staleTime: 30_000,
    },
  },
});
