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
    mutationMeta: { errorMessage?: string };
  }
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
    // A mutation is always something the user just did, so a failure always
    // surfaces.
    onError: (error, _variables, _context, mutation) => {
      const message = mutation.meta?.errorMessage;
      toast.error(
        message ?? (error instanceof Error ? error.message : "Request failed")
      );
    },
  }),
  defaultOptions: {
    queries: {
      // An ApiError carries the HTTP status that produced it, and a 401 or a
      // 404 will not become a 200 on the third try. Every fetch this cache
      // replaced was a single attempt inside a try/catch, and the polling
      // queries would stack retries on top of their own interval.
      retry: false,
      // Nothing in this app refetched on focus before, and in the editor a
      // focus refetch would rehydrate the graph from the server and throw away
      // whatever the user had not saved yet. Anything that needs to stay fresh
      // says so with its own refetchInterval.
      refetchOnWindowFocus: false,
      // Connections and workflow lists were previously fetched once into an
      // atom and refreshed only when something explicitly invalidated them.
      // Half a minute keeps that shape without the manual version counter.
      staleTime: 30_000,
    },
  },
});
