/**
 * Resolves host authentication into one request-scoped access policy. A host
 * passes `auth` as a function of the request or as an object holding that
 * function as `authenticate`; either answers an access policy, or `null` or
 * `undefined` for a request that is not signed in. Machine routes remain
 * outside this boundary because their own credentials prove their sender.
 */

import {
  WfGraphPermissions,
  type WfGraphOperation,
  type WfGraphOperationId,
  type WfGraphPermission,
} from "@wfgraph/shared/authorization/operations";

export type WfGraphAccess = Readonly<{
  allows: (operation: WfGraphOperation) => boolean | Promise<boolean>;
}>;

/**
 * Reads the operator's session from a request and answers their access
 * policy. `null` and `undefined` both mean the request is not signed in, which
 * Workflow Graph answers with a 401; a throw or rejection is answered with a
 * 500.
 */
export type WfGraphAuthenticate = (
  request: Request
) =>
  | WfGraphAccess
  | null
  | undefined
  | Promise<WfGraphAccess | null | undefined>;

/** The `auth` option: the authenticate function, or an object holding it. */
export type WfGraphAuth =
  | WfGraphAuthenticate
  | Readonly<{ authenticate: WfGraphAuthenticate }>;

type AuthFailureReporter = (failure: {
  stage: "authenticate" | "allows";
  error: unknown;
}) => void;

export type AuthContext = Readonly<{
  allows: (operation: WfGraphOperation) => Promise<boolean>;
}>;

export type ResolvedAuth = {
  authenticate: (
    request: Request,
    reportFailure?: AuthFailureReporter
  ) => Promise<AuthContext | null>;
};

/** The one 401 body, so both gates answer the same shape. */
export const UNAUTHORIZED_BODY = { error: "Unauthorized" };
/** The one 403 body for an authenticated caller lacking an operation grant. */
export const FORBIDDEN_BODY = { error: "Forbidden" };

function accessFromPermissions(
  permissions: Iterable<WfGraphPermission>
): WfGraphAccess {
  const granted = new Set(permissions);
  return Object.freeze({
    allows: (operation: WfGraphOperation) => granted.has(operation.permission),
  });
}

function accessFromOperationIds(
  operationIds: Iterable<WfGraphOperationId>
): WfGraphAccess {
  const granted = new Set(operationIds);
  return Object.freeze({
    allows: (operation: WfGraphOperation) => granted.has(operation.id),
  });
}

const allAccess: WfGraphAccess = Object.freeze({ allows: () => true });

export const WfGraphAccess = Object.freeze({
  /** Explicit unrestricted access for an authenticated request. */
  all: allAccess,
  fromPermissions: accessFromPermissions,
  fromOperationIds: accessFromOperationIds,
});

const viewerPermissions = [
  WfGraphPermissions.workflowRead,
  WfGraphPermissions.runRead,
  WfGraphPermissions.connectionRead,
] as const;

const editorPermissions = [
  ...viewerPermissions,
  WfGraphPermissions.workflowWrite,
  WfGraphPermissions.runManage,
  WfGraphPermissions.agentUse,
] as const;

export const WfGraphRoles = Object.freeze({
  viewer: accessFromPermissions(viewerPermissions),
  editor: accessFromPermissions(editorPermissions),
  admin: allAccess,
});

/**
 * Answers `authenticate` unchanged. It gives a callback written in a module of
 * its own, away from the `auth` option, its request and return types without
 * an annotation.
 */
export function defineWfGraphAuth(
  authenticate: WfGraphAuthenticate
): WfGraphAuthenticate {
  return authenticate;
}

/** Trust an upstream boundary to authenticate and authorize every request. */
export function trustWfGraphUpstream(): WfGraphAuth {
  return trustedUpstreamAuth;
}

const trustedUpstreamAuth: WfGraphAuthenticate = () => allAccess;

/**
 * The authenticate function `auth` holds, or a throw naming the option when
 * `auth` is neither form. `caller` names the function the host called, such
 * as "createWfGraphApp"; absent, the message names the option alone.
 */
function readAuthenticate(
  auth: unknown,
  caller: string | undefined
): WfGraphAuthenticate {
  if (typeof auth === "function") {
    return (request) => Reflect.apply(auth, undefined, [request]);
  }
  if (typeof auth === "object" && auth !== null) {
    const authenticate: unknown = Reflect.get(auth, "authenticate");
    if (typeof authenticate === "function") {
      return (request) => Reflect.apply(authenticate, auth, [request]);
    }
  }
  const option = caller === undefined ? "The auth option" : `${caller}'s auth`;
  throw new TypeError(
    `${option} must be a function of the request answering an access policy, or null when the request is not signed in, or an object holding that function as authenticate. Pass trustWfGraphUpstream() when an upstream component authenticates and authorizes every request.`
  );
}

class HostAuthFailure extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "HostAuthFailure";
  }
}

type UnknownAllows = (operation: WfGraphOperation) => unknown;

type ReadAllowsResult =
  | { ok: true; allows: UnknownAllows }
  | { ok: false; error: unknown };

function readAllows(access: unknown): ReadAllowsResult {
  try {
    if (
      (typeof access !== "object" && typeof access !== "function") ||
      access === null
    ) {
      return {
        ok: false,
        error: new TypeError(
          "The host authenticate callback must return an access policy, or null or undefined"
        ),
      };
    }
    const allows: unknown = Reflect.get(access, "allows");
    return typeof allows === "function"
      ? {
          ok: true,
          allows: (operation) => Reflect.apply(allows, access, [operation]),
        }
      : {
          ok: false,
          error: new TypeError(
            "The host authenticate callback must return an access policy, or null or undefined"
          ),
        };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Checks the host's `auth` option at once, throwing a message that names it
 * when it is neither a function nor an object with an `authenticate`
 * function, and answers the gate every operator route goes through.
 */
export function resolveAuth(
  auth: WfGraphAuth,
  caller?: string | undefined
): ResolvedAuth {
  const authenticate = readAuthenticate(auth, caller);
  return {
    authenticate: async (request, reportFailure = () => undefined) => {
      let access: unknown;
      try {
        access = await authenticate(request.clone());
      } catch (error) {
        reportFailure({ stage: "authenticate", error });
        throw new HostAuthFailure("Host authentication failed", error);
      }

      if (access === null || access === undefined) return null;

      const policy = readAllows(access);
      if (!policy.ok) {
        reportFailure({ stage: "authenticate", error: policy.error });
        throw new HostAuthFailure("Host authentication failed", policy.error);
      }

      let reportedPolicyFailure = false;
      return Object.freeze({
        allows: async (operation: WfGraphOperation) => {
          try {
            const allowed: unknown = await policy.allows(operation);
            if (typeof allowed !== "boolean") {
              throw new TypeError(
                "The host access policy must return a boolean or Promise<boolean>"
              );
            }
            return allowed;
          } catch (error) {
            if (!reportedPolicyFailure) {
              reportedPolicyFailure = true;
              reportFailure({ stage: "allows", error });
            }
            throw new HostAuthFailure("Host access policy failed", error);
          }
        },
      });
    },
  };
}
