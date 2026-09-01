import { describe, expect, it } from "vitest";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import {
  FORBIDDEN_BODY,
  resolveAuth,
  UNAUTHORIZED_BODY,
  type WfGraphAuth,
} from "#src/backend/lib/http/authorize";

const request = new Request("http://localhost/api/extensions");

describe("resolveAuth", () => {
  it("preserves a host principal type for the authorization callback", () => {
    type HostPrincipal = { id: string; organizationId: string };
    const auth: WfGraphAuth<HostPrincipal> = {
      authenticate: () => ({ id: "operator_1", organizationId: "org_1" }),
      authorize: (principal) => principal.organizationId === "org_1",
    };

    expect(
      auth.authorize?.(
        { id: "operator_1", organizationId: "org_1" },
        WfGraphOperations.workflowGetAll
      )
    ).toBe(true);
  });

  it("lets an upstream-authenticated host through", async () => {
    const context = await resolveAuth("external").authenticate(request);

    expect(context?.principal).toEqual({ id: "external" });
    expect(await context?.authorize(WfGraphOperations.workflowGetAll)).toBe(
      true
    );
  });

  it("retains the authenticated principal for the host authorization callback", async () => {
    const principal = { id: "operator_1", organizationId: "org_1" };
    const seen: unknown[] = [];
    const auth = resolveAuth({
      authenticate: (incoming) => {
        expect(incoming).toBe(request);
        return principal;
      },
      authorize: (incoming, operation) => {
        seen.push(incoming, operation);
        return true;
      },
    });

    const context = await auth.authenticate(request);

    expect(context?.principal).toEqual({
      id: "operator_1",
      organizationId: "org_1",
    });
    expect(await context?.authorize(WfGraphOperations.workflowGetAll)).toBe(
      true
    );
    expect(seen).toEqual([principal, WfGraphOperations.workflowGetAll]);
  });

  it("permits an authenticated principal when the host omits authorize", async () => {
    const context = await resolveAuth({
      authenticate: () => ({ id: "operator_1" }),
    }).authenticate(request);

    expect(await context?.authorize(WfGraphOperations.workflowGetAll)).toBe(
      true
    );
  });

  it("fails closed for malformed JavaScript principals", async () => {
    const throwingPrincipal = new Proxy(
      {},
      {
        get: () => {
          throw new Error("host principal getter failed");
        },
      }
    );
    for (const principal of [
      undefined,
      null,
      "operator_1",
      {},
      { id: 1 },
      [],
      throwingPrincipal,
    ]) {
      const auth = resolveAuth({
        authenticate: (() => principal) as () => { id: string } | null,
      });

      expect(await auth.authenticate(request)).toBeNull();
    }
  });

  it("fails closed when either host callback throws or returns a non-boolean grant", async () => {
    const authenticateThrower = resolveAuth({
      authenticate: () => {
        throw new Error("session store is down");
      },
    });
    const authorizeThrower = resolveAuth({
      authenticate: () => ({ id: "operator_1" }),
      authorize: () => {
        throw new Error("policy store is down");
      },
    });
    const authorizeWrongType = resolveAuth({
      authenticate: () => ({ id: "operator_1" }),
      authorize: (() => "yes") as unknown as () => boolean,
    });

    expect(await authenticateThrower.authenticate(request)).toBeNull();
    expect(
      await (
        await authorizeThrower.authenticate(request)
      )?.authorize(WfGraphOperations.workflowGetAll)
    ).toBe(false);
    expect(
      await (
        await authorizeWrongType.authenticate(request)
      )?.authorize(WfGraphOperations.workflowGetAll)
    ).toBe(false);
  });
});

describe("auth refusal bodies", () => {
  it("uses fixed bodies for authentication and authorization refusals", () => {
    expect(UNAUTHORIZED_BODY).toEqual({ error: "Unauthorized" });
    expect(FORBIDDEN_BODY).toEqual({ error: "Forbidden" });
  });
});
