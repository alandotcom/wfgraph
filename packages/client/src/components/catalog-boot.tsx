import { Button } from "#src/components/ui/button";
import { Spinner } from "#src/components/ui/spinner";
import type { CatalogLoadFailure } from "#src/lib/extensions";

/**
 * The two screens either side of the extension catalog's one fetch.
 *
 * The editor cannot draw a workflow before it knows what a workflow can do, so
 * the boot waits on that request. These are what the wait and its failure look
 * like; without them a cold server paints a blank document, and a failure paints
 * an editor that looks healthy and offers nothing.
 */
export function CatalogLoading() {
  return (
    <div className="flex h-dvh items-center justify-center">
      <Spinner className="size-6 text-muted-foreground" />
    </div>
  );
}

/** What each failure means for the person reading it. */
const FAILURE_SENTENCES: Record<CatalogLoadFailure, string> = {
  unreachable:
    "The server did not answer. It may be down, or something between the browser and it is dropping the request.",
  refused:
    "The server answered with an error. Check that Rova is mounted where this page expects it.",
  mismatch:
    "The server answered with a document this editor cannot read. The two are most likely different builds of Rova.",
};

export function CatalogUnavailable({
  endpoint,
  reason,
}: {
  endpoint: string;
  reason: CatalogLoadFailure;
}) {
  return (
    <div className="flex h-dvh items-center justify-center p-6">
      <div className="max-w-md space-y-3 rounded-lg border p-6">
        <h1 className="font-medium text-base">The editor cannot start</h1>
        <p className="text-muted-foreground text-sm">
          {FAILURE_SENTENCES[reason]}
        </p>
        <p className="text-muted-foreground text-sm">
          It asks <code className="font-mono text-xs">GET {endpoint}</code> for
          the Events, actions and integrations this server carries.
        </p>
        <Button
          onClick={() => window.location.reload()}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      </div>
    </div>
  );
}
