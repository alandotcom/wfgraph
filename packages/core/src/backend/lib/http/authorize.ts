/**
 * Authenticates an operator request and delegates operation decisions to the host.
 * Machine routes remain outside this boundary because their own credentials prove
 * their sender.
 */

import { getAppLogger } from "#src/backend/lib/logger";
import type { WfGraphOperation } from "@wfgraph/shared/authorization/operations";
import { getErrorMessage } from "@wfgraph/shared/utils";

const authLogger = getAppLogger("http", "auth");

export type WfGraphPrincipal = { id: string };

export type WfGraphAuth<P extends WfGraphPrincipal = WfGraphPrincipal> =
  | {
      /**
       * Read headers and the URL, not the body: this receives the live `Request`,
       * so consuming it here leaves every POST arriving empty downstream.
       */
      authenticate: (request: Request) => P | null | Promise<P | null>;
      authorize?: (
        principal: P,
        operation: WfGraphOperation
      ) => boolean | Promise<boolean>;
    }
  /** Something in front of Workflow Graph already authenticates and authorizes. */
  | "external";

export type AuthContext = {
  principal: WfGraphPrincipal;
  authorize: (operation: WfGraphOperation) => Promise<boolean>;
};

export type ResolvedAuth = {
  authenticate: (request: Request) => Promise<AuthContext | null>;
};

/** The one 401 body, so both gates answer the same shape. */
export const UNAUTHORIZED_BODY = { error: "Unauthorized" };
/** The one 403 body for an authenticated caller lacking an operation grant. */
export const FORBIDDEN_BODY = { error: "Forbidden" };

function isWfGraphPrincipal(value: unknown): value is WfGraphPrincipal {
  try {
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof Reflect.get(value, "id") === "string"
    );
  } catch {
    return false;
  }
}

const externalPrincipal: WfGraphPrincipal = Object.freeze({ id: "external" });

export function resolveAuth<P extends WfGraphPrincipal>(
  auth: WfGraphAuth<P>
): ResolvedAuth {
  if (auth === "external") {
    return {
      authenticate: () =>
        Promise.resolve({
          principal: externalPrincipal,
          authorize: () => Promise.resolve(true),
        }),
    };
  }

  return {
    authenticate: async (request) => {
      let principal: P | null;
      try {
        principal = await auth.authenticate(request);
      } catch (error) {
        authLogger.error(
          `The host's authenticate callback threw, so the request is denied: ${getErrorMessage(error)}`,
          { error }
        );
        return null;
      }

      if (!isWfGraphPrincipal(principal)) {
        return null;
      }

      return {
        principal,
        authorize: async (operation) => {
          if (!auth.authorize) {
            return true;
          }

          try {
            // Typed hosts answer a boolean, but an untyped JavaScript callback
            // can answer anything. Exactly true is the only grant.
            const allowed: unknown = await auth.authorize(principal, operation);
            return allowed === true;
          } catch (error) {
            authLogger.error(
              `The host's authorize callback threw, so the operation is denied: ${getErrorMessage(error)}`,
              { error }
            );
            return false;
          }
        },
      };
    },
  };
}
