/**
 * Task check for the wfgraph-core/auth skill: a host maps its own sessions to
 * Workflow Graph access policies. The developer task is "only signed-in
 * operators reach the editor, viewers can look but not publish, and editors can
 * publish", with grants that may come from the host's own store.
 *
 * `expectSessionBoundary` is the grader. It runs against the solutions the
 * skill recommends, and against the mistake the skill warns about (a policy
 * that grants everything), which it must reject.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  defineWfGraphAuth,
  WfGraphAccess,
  WfGraphPermissions,
  WfGraphRoles,
  type WfGraphAuth,
  type WfGraphPermission,
} from "@wfgraph/core";
import {
  createWorkflow,
  openHost,
  publishWorkflow,
  rest,
} from "#src/skills/host";

type Role = "viewer" | "editor";

/** The cookie a signed-in operator's browser sends. */
function sessionHeaders(role: Role): Record<string, string> {
  return { cookie: `session=${role}` };
}

/** The host's session adapter: the role a request's cookie names, or null. */
function readSessionRole(request: Request): Role | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = /(?:^|;\s*)session=(viewer|editor)(?:;|$)/.exec(cookie);
  return match?.[1] === "viewer" || match?.[1] === "editor" ? match[1] : null;
}

/** The recommended policy: a session's role mapped to a built-in role policy. */
const roleAuth = defineWfGraphAuth((request) => {
  const role = readSessionRole(request);
  return role === null ? null : WfGraphRoles[role];
});

/**
 * Grants the host keeps in its own store, as permission names. The viewer
 * and editor rows hold the same permissions as the built-in roles.
 */
const grantStore: Record<Role, readonly WfGraphPermission[]> = {
  viewer: [
    WfGraphPermissions.workflowRead,
    WfGraphPermissions.runRead,
    WfGraphPermissions.connectionRead,
  ],
  editor: [
    WfGraphPermissions.workflowRead,
    WfGraphPermissions.runRead,
    WfGraphPermissions.connectionRead,
    WfGraphPermissions.workflowWrite,
    WfGraphPermissions.runManage,
    WfGraphPermissions.agentUse,
  ],
};

/** A host policy, and how many times it has read the host's grant store. */
type CountedAuth = { auth: WfGraphAuth; storeReads: () => number };

/** A grant-store read that counts its calls. */
function countedGrantStore() {
  let reads = 0;
  return {
    readGrants: async (role: Role) => {
      reads += 1;
      return await Promise.resolve(grantStore[role]);
    },
    storeReads: () => reads,
  };
}

/**
 * The recommended custom policy: the grants load once in the authentication
 * callback, and `WfGraphAccess.fromPermissions` answers `allows` from the copy
 * it holds.
 */
function grantAuth(): CountedAuth {
  const { readGrants, storeReads } = countedGrantStore();
  return {
    auth: defineWfGraphAuth(async (request) => {
      const role = readSessionRole(request);
      if (role === null) return null;
      return WfGraphAccess.fromPermissions(await readGrants(role));
    }),
    storeReads,
  };
}

/**
 * The mistake the skill warns about for custom policies: a store read inside
 * `allows`. The boundary it enforces is correct, so only the read count shows
 * the fault.
 */
function grantReadPerOperationAuth(): CountedAuth {
  const { readGrants, storeReads } = countedGrantStore();
  return {
    auth: defineWfGraphAuth((request) => {
      const role = readSessionRole(request);
      if (role === null) return null;
      return {
        allows: async (operation) =>
          (await readGrants(role)).includes(operation.permission),
      };
    }),
    storeReads,
  };
}

/**
 * Asserts that loading the editor's boot snapshot, which asks `allows` about
 * every operation, reads the grant store once for the one request.
 */
async function expectOneStoreReadPerRequest(policy: CountedAuth) {
  const before = policy.storeReads();
  await grantedOperationIds(policy.auth, "viewer");
  expect(policy.storeReads() - before).toBe(1);
}

/**
 * The grader. It asserts, over HTTP, that a request with no session is
 * refused with 401, that a viewer can read workflows and is refused a publish
 * with 403, and that an editor can create and publish a workflow.
 */
async function expectSessionBoundary(auth: WfGraphAuth): Promise<void> {
  await using app = await openHost({ auth });

  const anonymousList = await rest(app, { method: "GET", path: "/workflows" });
  expect(anonymousList.status).toBe(401);
  const anonymousCreate = await rest(app, {
    method: "POST",
    path: "/workflows/create",
    body: { name: "Anonymous", graph: { nodes: [], edges: [] } },
  });
  expect(anonymousCreate.status).toBe(401);

  const viewerList = await rest(app, {
    method: "GET",
    path: "/workflows",
    headers: sessionHeaders("viewer"),
  });
  expect(viewerList.status).toBe(200);

  const workflow = await createWorkflow(app, sessionHeaders("editor"));
  const viewerPublish = await publishWorkflow(
    app,
    workflow,
    sessionHeaders("viewer")
  );
  expect(viewerPublish.status).toBe(403);
  const editorPublish = await publishWorkflow(
    app,
    workflow,
    sessionHeaders("editor")
  );
  expect(editorPublish.status).toBe(200);
}

/** The part of `GET /api/extensions` that lists a session's granted operations. */
const bootSnapshot = Schema.Struct({
  authorization: Schema.Struct({ operationIds: Schema.Array(Schema.String) }),
});

/** The operation ids the editor's boot snapshot grants a session. */
async function grantedOperationIds(
  auth: WfGraphAuth,
  role: Role
): Promise<string[]> {
  await using app = await openHost({ auth });
  const response = await app.fetch(
    new Request("http://localhost/api/extensions", {
      headers: sessionHeaders(role),
    })
  );
  expect(response.status).toBe(200);
  const body = Schema.decodeUnknownSync(bootSnapshot)(await response.json());
  return [...body.authorization.operationIds];
}

describe("wfgraph-core/auth task check", () => {
  it("refuses a request with no session, refuses a viewer's publish, and lets an editor publish", async () => {
    await expectSessionBoundary(roleAuth);
  });

  it("gives a policy built from the host's grants the same boundary as the role it matches", async () => {
    const policy = grantAuth();
    await expectSessionBoundary(policy.auth);

    for (const role of ["viewer", "editor"] as const) {
      // eslint-disable-next-line eslint/no-await-in-loop -- one app per role
      expect(await grantedOperationIds(policy.auth, role)).toEqual(
        // eslint-disable-next-line eslint/no-await-in-loop -- one app per role
        await grantedOperationIds(roleAuth, role)
      );
    }
    await expectOneStoreReadPerRequest(policy);
  });

  it("rejects a custom policy that reads the grant store inside allows", async () => {
    const policy = grantReadPerOperationAuth();
    // The boundary holds, which is why this mistake survives a review that
    // only tries the routes.
    await expectSessionBoundary(policy.auth);
    await expect(expectOneStoreReadPerRequest(policy)).rejects.toThrow(
      "to be 1"
    );
  });

  // The mistake the skill warns about: a policy that grants every operation
  // to every request, written to "get auth out of the way". The grader must
  // reject it, or it would pass an editor the internet can open.
  it("rejects a policy that grants everything", async () => {
    const grantsEverything = defineWfGraphAuth(() => WfGraphAccess.all);
    // The first assertion to fail is the anonymous request's: it answers 200.
    await expect(expectSessionBoundary(grantsEverything)).rejects.toThrow(
      "expected 200 to be 401"
    );
  });
});
