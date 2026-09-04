import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  WfGraphOperations,
  WfGraphPermissions,
} from "@wfgraph/shared/authorization/operations";
import {
  defineWfGraphAuth,
  FORBIDDEN_BODY,
  resolveAuth,
  trustWfGraphUpstream,
  UNAUTHORIZED_BODY,
  WfGraphAccess,
  WfGraphRoles,
  type WfGraphAuth,
} from "#src/backend/lib/http/authorize";

const request = new Request("http://localhost/api/extensions");

describe("Workflow Graph access policies", () => {
  it("provides directly usable immutable viewer, editor, and admin roles", async () => {
    expect(
      await WfGraphRoles.viewer.allows(WfGraphOperations.workflowGetAll)
    ).toBe(true);
    expect(
      await WfGraphRoles.viewer.allows(WfGraphOperations.workflowCreate)
    ).toBe(false);
    expect(
      await WfGraphRoles.editor.allows(WfGraphOperations.workflowCreate)
    ).toBe(true);
    expect(
      await WfGraphRoles.editor.allows(WfGraphOperations.integrationCreate)
    ).toBe(false);
    expect(
      Object.values(WfGraphOperations).every((operation) =>
        WfGraphRoles.admin.allows(operation)
      )
    ).toBe(true);
    expect(Object.isFrozen(WfGraphRoles)).toBe(true);
    expect(Object.isFrozen(WfGraphRoles.viewer)).toBe(true);
  });

  it("builds local policies from permissions and exact operation IDs", () => {
    const byPermission = WfGraphAccess.fromPermissions([
      WfGraphPermissions.workflowRead,
    ]);
    const byOperation = WfGraphAccess.fromOperationIds([
      WfGraphOperations.workflowGetById.id,
    ]);

    expect(byPermission.allows(WfGraphOperations.workflowGetAll)).toBe(true);
    expect(byPermission.allows(WfGraphOperations.workflowCreate)).toBe(false);
    expect(byOperation.allows(WfGraphOperations.workflowGetById)).toBe(true);
    expect(byOperation.allows(WfGraphOperations.workflowGetAll)).toBe(false);
    expect(WfGraphAccess.all.allows(WfGraphOperations.workflowDelete)).toBe(
      true
    );
    expect(Object.isFrozen(byPermission)).toBe(true);
    expect(Object.isFrozen(byOperation)).toBe(true);
    expect(Object.isFrozen(WfGraphAccess.all)).toBe(true);
  });
});

describe("resolveAuth", () => {
  it("gives extracted authentication callbacks contextual request and access types", async () => {
    const grants = new Set<string>([WfGraphOperations.workflowGetAll.id]);
    const auth = defineWfGraphAuth(async (incoming) => {
      expectTypeOf(incoming).toEqualTypeOf<Request>();
      return {
        allows(operation) {
          expectTypeOf(operation).toEqualTypeOf<
            (typeof WfGraphOperations)[keyof typeof WfGraphOperations]
          >();
          return grants.has(operation.id);
        },
      };
    });
    expectTypeOf(auth).toEqualTypeOf<WfGraphAuth>();

    const access = await resolveAuth(auth).authenticate(request);

    expect(await access?.allows(WfGraphOperations.workflowGetAll)).toBe(true);
    expect(await access?.allows(WfGraphOperations.workflowCreate)).toBe(false);
  });

  it("passes a clone so host body reads do not drain the downstream request", async () => {
    const original = new Request("http://localhost/api/rpc/workflow/create", {
      method: "POST",
      body: "request body",
    });
    const auth = defineWfGraphAuth(async (incoming) => {
      expect(incoming).not.toBe(original);
      expect(await incoming.text()).toBe("request body");
      return WfGraphAccess.all;
    });

    await expect(
      resolveAuth(auth).authenticate(original)
    ).resolves.toBeDefined();
    await expect(original.text()).resolves.toBe("request body");
  });

  it("returns null only when the host explicitly returns null", async () => {
    const access = await resolveAuth(
      defineWfGraphAuth(() => null)
    ).authenticate(request);

    expect(access).toBeNull();
  });

  it("makes unrestricted upstream trust explicit without a principal", async () => {
    const access = await resolveAuth(trustWfGraphUpstream()).authenticate(
      request
    );

    expect(access).toBeDefined();
    expect(await access?.allows(WfGraphOperations.workflowGetAll)).toBe(true);
    expect(Object.keys(access ?? {})).toEqual(["allows"]);
  });

  it("treats authentication exceptions and malformed access as system failures", async () => {
    const report = vi.fn();
    const authenticateThrower = resolveAuth(
      defineWfGraphAuth(() => {
        throw new Error("session store is down");
      })
    );
    const malformed = resolveAuth(
      defineWfGraphAuth(
        (() => undefined) as unknown as WfGraphAuth["authenticate"]
      )
    );

    await expect(
      authenticateThrower.authenticate(request, report)
    ).rejects.toThrow("Host authentication failed");
    await expect(malformed.authenticate(request, report)).rejects.toThrow(
      "Host authentication failed"
    );
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("treats policy exceptions and malformed decisions as one reported system failure", async () => {
    const report = vi.fn();
    const access = await resolveAuth(
      defineWfGraphAuth(() => ({
        allows: (() => {
          throw new Error("policy store is down");
        }) as () => boolean,
      }))
    ).authenticate(request, report);

    await expect(
      Promise.all(
        Object.values(WfGraphOperations).map((operation) =>
          access?.allows(operation)
        )
      )
    ).rejects.toThrow("Host access policy failed");
    expect(report).toHaveBeenCalledTimes(1);

    const wrongType = await resolveAuth(
      defineWfGraphAuth(() => ({
        allows: (() => "yes") as unknown as () => boolean,
      }))
    ).authenticate(request);
    await expect(
      wrongType?.allows(WfGraphOperations.workflowGetAll)
    ).rejects.toThrow("Host access policy failed");
  });
});

describe("auth refusal bodies", () => {
  it("uses fixed bodies for authentication and authorization refusals", () => {
    expect(UNAUTHORIZED_BODY).toEqual({ error: "Unauthorized" });
    expect(FORBIDDEN_BODY).toEqual({ error: "Forbidden" });
  });
});
