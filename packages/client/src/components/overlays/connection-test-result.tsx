import { Check, X } from "lucide-react";
import { describeConnectionTestFailure } from "#src/lib/run-failure";

/** What the server answers a Connection test with. A failed test is an answer too. */
type ConnectionTestAnswer = {
  status: "success" | "error";
  message: string;
};

/**
 * The answer to a Connection test, shown where the test was pressed: under the
 * credentials in a Connection form, or under a row of the Connections list. A
 * failure reads as the sentence `describeConnectionTestFailure` builds, with
 * the integration's own answer beneath it for a developer.
 */
export function ConnectionTestResult({
  answer,
  integrationLabel,
  connectionName,
}: {
  answer: ConnectionTestAnswer;
  integrationLabel: string;
  /** The saved Connection's name, or null for credentials not yet saved. */
  connectionName: string | null;
}) {
  if (answer.status === "success") {
    return (
      <p className="flex items-start gap-2 text-sm" role="status">
        <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
        {answer.message || "Connection successful"}
      </p>
    );
  }

  const failure = describeConnectionTestFailure({
    error: answer.message || "The test failed.",
    integrationLabel,
    connectionName,
  });
  return (
    <div className="flex items-start gap-2 text-sm" role="alert">
      <X aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 space-y-1">
        <p className="break-words">
          <span className="font-medium">Test failed.</span> {failure.sentence}
        </p>
        {failure.detail === null ? null : (
          <p className="break-words font-mono text-muted-foreground text-xs">
            {failure.detail}
          </p>
        )}
      </div>
    </div>
  );
}
