/**
 * Who is allowed to reach the mounted app.
 *
 * The host supplies a predicate; Rova supplies the knowledge of which routes it
 * applies to. That split is why this is an option rather than middleware a host
 * wraps the mount in: the Inngest callback and the webhook and resume paths are
 * reached by machines carrying their own credentials, and gating them uniformly
 * would break all three.
 *
 * The predicate authorizes; it does not identify. No table carries a tenant or a
 * user column, so a `Principal` type Rova defined and never read would be
 * interface weight with nothing behind it.
 */

import { getAppLogger } from "#src/backend/lib/logger";
import { getErrorMessage } from "@rova/shared/utils";

const authLogger = getAppLogger("http", "auth");

export type RovaAuth =
  /**
   * Read headers and the URL, not the body: this receives the live `Request`,
   * so consuming it here leaves every POST arriving empty downstream.
   */
  | ((request: Request) => boolean | Promise<boolean>)
  /** Something in front of Rova already gates it, said deliberately. */
  | "external";

export type Authorize = (request: Request) => Promise<boolean>;

/** The one 401 body, so both gates answer the same shape. */
export const UNAUTHORIZED_BODY = { error: "Unauthorized" };

export function resolveAuthorize(auth: RovaAuth): Authorize {
  if (auth === "external") {
    return () => Promise.resolve(true);
  }

  return async (request) => {
    try {
      // Typed as boolean, but a JavaScript host can answer anything, so the
      // declared type is not trusted here. Only exactly true gets through.
      const answer: unknown = await auth(request);
      return answer === true;
    } catch (error) {
      authLogger.error(
        `The host's auth predicate threw, so the request is denied: ${getErrorMessage(error)}`,
        { error }
      );
      return false;
    }
  };
}
