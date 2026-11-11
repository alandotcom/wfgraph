import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { fixtureCatalog } from "@wfgraph/agent/tools/catalog-fixture";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { AuthContext } from "#src/backend/lib/http/authorize";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import {
  boundedOutput,
  makeWorkflowOperations,
  RUN_STEP_OUTPUT_CHARS,
} from "#src/backend/services/agent/workflow-operations";

/** The fixture catalog with Slack's channel field backed by a provider. */
const catalog: ExtensionCatalog = {
  ...fixtureCatalog,
  actions: fixtureCatalog.actions.map((action) =>
    action.id === "slack/send-message"
      ? {
          ...action,
          configFields: action.configFields.map((field) =>
            "key" in field && field.key === "channel"
              ? { ...field, optionsSource: { provider: "channels" } }
              : field
          ),
        }
      : action
  ),
};

// Every repository method dies unless named, so a refusal that reached a query
// would fail these cases rather than pass them.
const runtime = stubWfGraphRuntime({ extensions: { catalog } });
afterAll(async () => runtime.dispose());

function operationsFor(auth: AuthContext) {
  return runtime.runPromise(
    makeWorkflowOperations({ workflowId: "wf_1", auth })
  );
}

const refusalOf = <A>(effect: Effect.Effect<A, { readonly reason: string }>) =>
  runtime.runPromise(Effect.flip(effect)).then((failure) => failure.reason);

describe("makeWorkflowOperations", () => {
  it("refuses a run read the caller holds no run grant for", async () => {
    const asked: string[] = [];
    const operations = await operationsFor({
      allows: async (operation) => {
        asked.push(operation.id);
        return false;
      },
    });

    const reason = await refusalOf(operations.listRuns({ limit: 5 }));

    expect(asked).toEqual(["workflow.getExecutions"]);
    expect(reason).toContain("Forbidden");
  });

  it("refuses a test run without the run grant before starting anything", async () => {
    const operations = await operationsFor({
      allows: async (operation) => operation.id !== "workflow.execute",
    });

    const reason = await refusalOf(
      operations.startTestRun({ payload: {}, eventName: undefined })
    );

    expect(reason).toContain("workflow.execute");
  });

  it("names a field that has no options provider", async () => {
    const operations = await operationsFor({ allows: async () => true });

    const reason = await refusalOf(
      operations.fieldOptions({
        actionId: "score-applicant",
        fieldKey: "applicantId",
        integrationId: undefined,
        parameters: {},
      })
    );

    expect(reason).toContain("no options provider");
  });

  it("asks for the step's connection on an integration action", async () => {
    const operations = await operationsFor({ allows: async () => true });

    const reason = await refusalOf(
      operations.fieldOptions({
        actionId: "slack/send-message",
        fieldKey: "channel",
        integrationId: undefined,
        parameters: {},
      })
    );

    expect(reason).toContain("integrationId");
  });
});

describe("boundedOutput", () => {
  it("cuts a long output and still reports its full size", () => {
    const output = { text: "x".repeat(RUN_STEP_OUTPUT_CHARS * 2) };

    const bounded = boundedOutput(output);

    expect(bounded.outputBytes).toBe(JSON.stringify(output).length);
    expect(bounded.output?.length).toBeLessThan(RUN_STEP_OUTPUT_CHARS + 20);
    expect(bounded.output?.endsWith("(cut)")).toBe(true);
  });

  it("answers no output for a step that produced none", () => {
    expect(boundedOutput(null)).toEqual({ outputBytes: 0 });
  });
});
