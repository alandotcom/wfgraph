import { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";

// The registry reads the workflows table to decide which run functions exist.
// Which ones it builds is beside the point here, so the query answers nothing
// and no connection is opened; vitest scopes a mock to the file that declares it.
vi.mock("#src/backend/lib/db/index", () => ({
  db: { query: { workflows: { findMany: () => Promise.resolve([]) } } },
}));
import { CURRENT_WORKFLOW_NAME } from "#src/backend/lib/workflow-constants";
import { assembleExtensions } from "#src/backend/lib/extensions/extension-set";
import { noWorkflowActions } from "#src/backend/lib/workflow-engine/actions";
import { createRovaRuntime } from "#src/backend/runtime";
import {
  buildWorkflowFunctions,
  createInngestFunctionRegistry,
} from "./functions";

// Constructing a client opens nothing; these functions are never invoked.
const client = new Inngest({ id: "functions-test", isDev: true });
// A registry builds its event listeners against a runtime, and reads the
// surface off it. This one runs nothing but that read, so no other Layer is
// constructed.
const runtime = createRovaRuntime(
  {
    client,
    invalidate: () => {},
    serve: () => Promise.reject(new Error("not served here")),
  },
  assembleExtensions({})
);

/**
 * The run functions, which are one per saved workflow and keyed on its id.
 *
 * Nothing here reads a graph. The event listeners are the catalog's, one per
 * Event, and `event-listener-function.test.ts` covers them: which Events exist
 * stopped being a question about saved graphs when the per-workflow listener went.
 */
describe("buildWorkflowFunctions", () => {
  it("creates one function per workflow with stable ids", () => {
    const functions = buildWorkflowFunctions(
      client,
      [
        { id: "workflow_123", name: "Order Updates" },
        { id: "workflow_999", name: CURRENT_WORKFLOW_NAME },
      ],
      noWorkflowActions
    );

    expect(functions).toHaveLength(1);
    expect(functions[0].id()).toBe("workflow-workflow_123");
    expect(functions[0].name).toBe("Order Updates");
  });

  // The draft has no run of its own: it is what the editor autosaves into, and
  // nothing starts it.
  it("excludes the editor's draft", () => {
    const functions = buildWorkflowFunctions(
      client,
      [{ id: "workflow_only_current", name: CURRENT_WORKFLOW_NAME }],
      noWorkflowActions
    );

    expect(functions).toHaveLength(0);
  });

  it("handles an empty workflow list", () => {
    expect(buildWorkflowFunctions(client, [], noWorkflowActions)).toHaveLength(
      0
    );
  });
});

/**
 * The cache, which decides how long a newly saved workflow stays invisible to
 * Inngest.
 *
 * Array identity is the whole test: the registry hands back the same array
 * while its short TTL holds, and a new one after a write says the list is
 * stale. Each app owns a registry of its own, so the invalidation a save
 * performs reaches that app's list and no other.
 */
describe("the function registry's cache", () => {
  it("answers the same list until something invalidates it", async () => {
    const registry = createInngestFunctionRegistry(client);

    const built = await registry.get(runtime);

    expect(await registry.get(runtime)).toBe(built);

    registry.invalidate();

    expect(await registry.get(runtime)).not.toBe(built);
  });

  // What holds one app's save to one app's list: the second registry's cache
  // survives the first's invalidation, so it answers the same array it built.
  it("gives two registries lists of their own", async () => {
    const first = createInngestFunctionRegistry(client);
    const second = createInngestFunctionRegistry(client);

    const firstList = await first.get(runtime);
    const secondList = await second.get(runtime);
    expect(secondList).not.toBe(firstList);

    first.invalidate();

    expect(await second.get(runtime)).toBe(secondList);
    expect(await first.get(runtime)).not.toBe(firstList);
  });
});
