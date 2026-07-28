import { describe, expect, it } from "vitest";
import {
  resolveAuthorize,
  UNAUTHORIZED_BODY,
} from "#src/backend/lib/http/authorize";

const request = new Request("http://localhost/api/extensions");

describe("resolveAuthorize", () => {
  it("lets everything through when the host gates upstream", async () => {
    expect(await resolveAuthorize("external")(request)).toBe(true);
  });

  it("asks the host's predicate, sync or async", async () => {
    expect(await resolveAuthorize(() => false)(request)).toBe(false);
    expect(await resolveAuthorize(() => true)(request)).toBe(true);
    expect(await resolveAuthorize(() => Promise.resolve(true))(request)).toBe(
      true
    );
  });

  it("hands the predicate the request itself", async () => {
    const seen: Request[] = [];
    await resolveAuthorize((incoming) => {
      seen.push(incoming);
      return true;
    })(request);

    expect(seen[0]?.url).toBe("http://localhost/api/extensions");
  });

  // A predicate is typed to answer a boolean, but a JavaScript host or a loosely
  // typed wrapper can answer anything. At this boundary the safe reading of a
  // value that is not `true` is "no": a returned session object is a mistake,
  // and truthiness would turn that mistake into allow-all.
  it("treats anything that is not exactly true as a refusal", async () => {
    const notTrue = [undefined, null, 0, "", "false", "true", {}, []];

    for (const value of notTrue) {
      const authorize = resolveAuthorize(
        // eslint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately wrong on purpose
        (() => value) as unknown as () => boolean
      );
      expect(await authorize(request)).toBe(false);
    }
  });

  it("denies when the predicate throws or rejects", async () => {
    const thrower = resolveAuthorize(() => {
      throw new Error("session store is down");
    });
    const rejecter = resolveAuthorize(() =>
      Promise.reject(new Error("session store is down"))
    );

    expect(await thrower(request)).toBe(false);
    expect(await rejecter(request)).toBe(false);
  });
});

describe("UNAUTHORIZED_BODY", () => {
  // Both gates answer this, and the client parses it as an oRPC error, so the
  // SPA can tell an expired session from a broken route.
  it("is the one shape a refusal takes", () => {
    expect(UNAUTHORIZED_BODY).toEqual({ error: "Unauthorized" });
  });
});
