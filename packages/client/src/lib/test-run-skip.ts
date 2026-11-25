/**
 * Whether a step in a test run finished without doing its work, and why. A
 * test run calls every handler, and a handler that sends nothing in a test run
 * still succeeds, so its log status alone reads as a send that never happened.
 * Two conventions mark such an answer: a built-in integration returns a
 * `reasonCode` starting `test_mode_`, and a host action returns
 * `{ status: "skipped" }` (docs/embedding.md, "Test runs call your handler").
 */

import type { NodeLogStatus } from "@wfgraph/shared/lifecycle/execution-contracts";
import { isJsonObject, readJsonValue } from "@wfgraph/shared/types/json";

/** The status word a step a test run skipped reads in place of Successful. */
export const TEST_RUN_SKIP_LABEL = "Skipped (test run)";

/**
 * The sentence for each `reasonCode` the built-in integrations return, in the
 * words of the Test Mode Behavior setting that chose it.
 */
const REASON_SENTENCES: Readonly<Record<string, string>> = {
  test_mode_log_only:
    "Test Mode Behavior is Log only, so this test run did nothing at this step.",
  test_mode_log_fallback_missing_test_phone:
    "Test Phone Number is empty, so this test run did nothing at this step.",
  test_mode_log_fallback_invalid_test_phone:
    "Test Phone Number is not a valid phone number, so this test run did nothing at this step.",
  test_mode_log_fallback_missing_test_email:
    "Test Email Address is empty, so this test run did nothing at this step.",
  test_mode_log_fallback_invalid_test_email:
    "Test Email Address is not a valid email address, so this test run did nothing at this step.",
};

/**
 * One sentence saying why a successful step of a test run did nothing, or null
 * when the step did its work, did not succeed, or the run had Live recipients.
 */
export function testRunSkip(input: {
  runMode: "live" | "test";
  status: NodeLogStatus;
  output: unknown;
}): string | null {
  if (input.runMode !== "test" || input.status !== "success") {
    return null;
  }
  const output = readJsonValue(input.output);
  if (!isJsonObject(output)) {
    return null;
  }
  const { reasonCode, status } = output;
  if (typeof reasonCode === "string" && reasonCode.startsWith("test_mode_")) {
    return (
      REASON_SENTENCES[reasonCode] ?? "This test run did nothing at this step."
    );
  }
  return status === "skipped" ? "The app skips this step in a test run." : null;
}
