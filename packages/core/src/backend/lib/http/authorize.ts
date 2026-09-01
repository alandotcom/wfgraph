/**
 * Resolves host authentication into one request-scoped access policy. Machine
 * routes remain outside this boundary because their own credentials prove their
 * sender.
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

export type WfGraphAuth = Readonly<{
  authenticate: (
    request: Request
  ) => WfGraphAccess | null | Promise<WfGraphAccess | null>;
}>;

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
 * Gives an extracted authentication callback contextual request and return
 * types, then packages it for `createWfGraphApp` or `wfWorker`.
 */
export function defineWfGraphAuth(
  authenticate: WfGraphAuth["authenticate"]
): WfGraphAuth {
  return Object.freeze({ authenticate });
}

/** Trust an upstream boundary to authenticate and authorize every request. */
export function trustWfGraphUpstream(): WfGraphAuth {
  return trustedUpstreamAuth;
}

const trustedUpstreamAuth = defineWfGraphAuth(() => allAccess);

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
          "The host authenticate callback must return an access policy or null"
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
            "The host authenticate callback must return an access policy or null"
          ),
        };
  } catch (error) {
    return { ok: false, error };
  }
}

export function resolveAuth(auth: WfGraphAuth): ResolvedAuth {
  return {
    authenticate: async (request, reportFailure = () => undefined) => {
      let access: unknown;
      try {
        access = await auth.authenticate(request.clone());
      } catch (error) {
        reportFailure({ stage: "authenticate", error });
        throw new HostAuthFailure("Host authentication failed", error);
      }

      if (access === null) return null;

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
