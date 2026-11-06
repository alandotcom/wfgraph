import { describe, expect, expectTypeOf, it } from "vitest";
import {
  defineWfGraphAuth,
  WfGraphAccess,
  wfWorker,
  type WfGraphWorker,
  type WfGraphWorkerOptions,
} from "#src/worker";
import type { WfGraphPersistence } from "#src/backend/persistence/types";

describe("wfWorker", () => {
  it("keeps one environment type while auth closes over arbitrary session state", () => {
    type WorkerEnv = { INTEGRATION_ENCRYPTION_KEY: string };
    type HostSession = { organizationId: string; grants: ReadonlySet<string> };

    const session: HostSession = {
      organizationId: "org-1",
      grants: new Set(["workflow.read"]),
    };
    const auth = defineWfGraphAuth(async () => {
      await Promise.resolve();
      return {
        allows: (operation) =>
          session.organizationId === "org-1" &&
          session.grants.has(operation.permission),
      };
    });
    const persistence = undefined as unknown as WfGraphPersistence;
    const options: WfGraphWorkerOptions<WorkerEnv> = {
      request: (env) => ({
        auth,
        persistence,
        encryption: { key: env.INTEGRATION_ENCRYPTION_KEY },
        inngest: { id: "wfgraph-worker-test", isDev: true },
      }),
    };

    expectTypeOf(options).toExtend<Parameters<typeof wfWorker<WorkerEnv>>[0]>();
    expectTypeOf(wfWorker<WorkerEnv>).returns.toEqualTypeOf<
      WfGraphWorker<WorkerEnv>
    >();
    expect(WfGraphAccess.all.allows).toBeTypeOf("function");
  });

  // A Worker invocation has no long-lived process for the executor's worker
  // loop, so building the handler fails at boot rather than accepting runs it
  // would never execute.
  it("refuses to start until the Worker backend has its tick driver", () => {
    expect(() =>
      wfWorker({
        request: () => {
          throw new Error("unused");
        },
      })
    ).toThrow(/runs it once its tick driver ships/);
  });
});
