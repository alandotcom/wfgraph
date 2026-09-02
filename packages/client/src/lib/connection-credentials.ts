import { isBlank } from "@wfgraph/shared/types/string";
import { toast } from "sonner";

/**
 * The two things a connection form does with credentials.
 *
 * Adding a connection and editing one are near-duplicate overlays that each
 * carried their own copy of both, and the Connections screen carried a third
 * copy of the reporting half.
 */

/**
 * Whether the user typed anything into the credential fields.
 *
 * On the edit form this is also how "keep the stored credentials" is said: the
 * secret fields render as Configured until the user chooses to replace them, so
 * an empty config means untouched rather than blank.
 */
export function hasProvidedConfigValues(
  config: Record<string, string>
): boolean {
  return Object.values(config).some((value) => !isBlank(value));
}

/**
 * Report a connection test. Testing typed-in credentials and testing stored
 * ones are separate procedures that answer with the same shape, and a failed
 * test is a successful response, so this is a success handler in both cases.
 */
export function announceTestResult(result: {
  status: "success" | "error";
  message: string;
}) {
  if (result.status === "success") {
    toast.success(result.message || "Connection successful");
  } else {
    toast.error(result.message || "Connection failed");
  }
}
