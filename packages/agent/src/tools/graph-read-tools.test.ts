import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import {
  heroGraph,
  outlineTestCatalog,
} from "@wfgraph/shared/graph/workflow-outline-test-support";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { emptyLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { fixtureCatalog } from "#src/tools/catalog-fixture";
import { agentToolsFor } from "#src/testing";

const catalog = fixtureCatalog;

const lifecycle: WorkflowNode = {
  id: "entry",
  position: { x: 0, y: 0 },
  type: "lifecycle",
  data: {
    label: "Lifecycle",
    type: "lifecycle",
    config: {
      lifecycleRules: {
        ...emptyLifecycleRules,
        startEvents: ["applicant.created"],
      },
    },
  },
};

const slackNode: WorkflowNode = {
  id: "notify",
  position: { x: 0, y: 160 },
  type: "action",
  data: {
    label: "Notify the team",
    description: "Tell #hiring about the applicant.",
    type: "action",
    enabled: true,
    config: {
      actionType: "slack/send-message",
      integrationId: "conn-1",
      channel: "#hiring",
      text: "New applicant",
    },
  },
};

const entryToSlack: WorkflowEdge = {
  id: "entry->notify",
  source: "entry",
  target: "notify",
  sourceHandle: "started",
};

describe("read_workflow", () => {
  it.effect("answers compact topology without positions or config", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycle, slackNode],
        edges: [entryToSlack],
        catalog,
      });
      const result = yield* tools.read_workflow({});

      expect(result.nodes).toEqual([
        {
          id: "entry",
          label: "Lifecycle",
          type: "lifecycle",
        },
        {
          id: "notify",
          label: "Notify the team",
          type: "action",
          stepNumber: 1,
          actionType: "slack/send-message",
          testRun: expect.stringContaining('Has no "In test runs" setting'),
          description: "Tell #hiring about the applicant.",
        },
      ]);
      expect(result.edges).toEqual([
        {
          id: "entry->notify",
          source: "entry",
          target: "notify",
          sourceHandle: "started",
        },
      ]);
    })
  );

  it.effect("pages large graph topology", () =>
    Effect.gen(function* () {
      const nodes = Array.from({ length: 25 }, (_, index): WorkflowNode => ({
        ...slackNode,
        id: `node-${index}`,
        data: { ...slackNode.data, label: `Node ${index}` },
      }));
      const { tools } = yield* agentToolsFor({
        nodes,
        edges: [],
        catalog,
      });
      const defaultPage = yield* tools.read_workflow({});
      const result = yield* tools.read_workflow({ nodeOffset: 3, limit: 2 });

      expect(defaultPage.nodes).toHaveLength(20);
      expect(defaultPage.nextNodeOffset).toBe(20);
      expect(result.nodes.map((node) => node.id)).toEqual(["node-3", "node-4"]);
      expect(result.totalNodes).toBe(25);
      expect(result.nextNodeOffset).toBe(5);
    })
  );

  it.effect("leaves sourceHandle off an edge that names none", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycle, slackNode],
        edges: [{ id: "plain", source: "entry", target: "notify" }],
        catalog,
      });
      const result = yield* tools.read_workflow({});

      expect(result.edges[0]).toEqual({
        id: "plain",
        source: "entry",
        target: "notify",
      });
    })
  );

  it.effect("answers an empty graph rather than refusing", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });
      const result = yield* tools.read_workflow({});

      expect(result).toEqual({
        nodes: [],
        edges: [],
        totalNodes: 0,
        totalEdges: 0,
      });
    })
  );

  it.effect("reports each node's Group and each Group's members", () =>
    Effect.gen(function* () {
      const frame: WorkflowNode = {
        id: "lookups",
        position: { x: 0, y: 0 },
        type: "group",
        data: { label: "Lookups", type: "group" },
      };
      const members = ["a", "b"].map((id): WorkflowNode => ({
        ...slackNode,
        id,
        parentId: frame.id,
        data: { ...slackNode.data, label: id },
      }));
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycle, frame, ...members, slackNode],
        edges: [],
        catalog,
      });

      const topology = yield* tools.read_workflow({});
      const detail = yield* tools.read_nodes({ nodeIds: ["lookups", "a"] });

      expect(
        topology.nodes.map(({ id, label, groupId, memberIds }) => ({
          id,
          label,
          groupId,
          memberIds,
        }))
      ).toEqual([
        { id: "entry", label: "Lifecycle" },
        { id: "lookups", label: "Lookups", memberIds: ["a", "b"] },
        { id: "a", label: "a", groupId: "lookups" },
        { id: "b", label: "b", groupId: "lookups" },
        { id: "notify", label: "Notify the team" },
      ]);
      expect(detail.nodes[0]).toMatchObject({ memberIds: ["a", "b"] });
      expect(detail.nodes[1]).toMatchObject({ groupId: "lookups" });
    })
  );
});

describe("step numbers", () => {
  // The seeded "Appointment reminders" workflow stores its nodes in an order
  // that differs from run order, which is how a person once asked about step 7
  // and was answered about the outline's step 3.
  it.effect("give each step the number the editor's outline prints", () =>
    Effect.gen(function* () {
      const { nodes, edges } = heroGraph();
      const { tools } = yield* agentToolsFor({
        nodes,
        edges,
        catalog: outlineTestCatalog,
      });

      const topology = yield* tools.read_workflow({ limit: 50 });
      const byNumber = new Map(
        topology.nodes.flatMap((node) =>
          node.stepNumber === undefined ? [] : [[node.stepNumber, node.label]]
        )
      );

      expect(byNumber.get(3)).toBe("Wait until 24 hours before");
      expect(byNumber.get(7)).toBe("Wait for deposit or reschedule");
      expect(byNumber.get(16)).toBe("Send cancellation notice");
      expect(byNumber.size).toBe(16);
      expect(
        topology.nodes.find((node) => node.type === "lifecycle")?.stepNumber
      ).toBeUndefined();
      expect(
        topology.nodes.find((node) => node.type === "group")?.stepNumber
      ).toBeUndefined();

      const detail = yield* tools.read_nodes({
        nodeIds: ["Wait for deposit or reschedule"],
      });
      expect(detail.nodes[0]?.stepNumber).toBe(7);
    })
  );

  it.effect("renumber the steps after a write moves them in run order", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycle, slackNode],
        edges: [entryToSlack],
        catalog,
      });

      yield* tools.insert_node_on_edge({
        edgeId: entryToSlack.id,
        actionId: BUILT_IN_ACTION_IDS.wait,
        label: "Wait a day",
      });
      const topology = yield* tools.read_workflow({});

      expect(
        topology.nodes.map(({ label, stepNumber }) => ({ label, stepNumber }))
      ).toEqual([
        { label: "Lifecycle" },
        { label: "Notify the team", stepNumber: 2 },
        { label: "Wait a day", stepNumber: 1 },
      ]);
    })
  );
});

describe("testRun", () => {
  /**
   * An SMS action with the "In test runs" select the built-in Twilio action
   * declares, and a host action with no such setting, as the seeded clinic's
   * Send Patient Message is.
   */
  const testRunCatalog: ExtensionCatalog = {
    ...fixtureCatalog,
    actions: [
      {
        id: "twilio/send-sms",
        label: "Send SMS",
        description: "Send a text message.",
        category: "Messaging",
        integration: "twilio",
        sideEffect: true,
        configFields: [
          { key: "smsTo", label: "To", type: "template-input" },
          {
            key: "testBehavior",
            label: "In test runs",
            type: "select",
            defaultValue: "log_only",
            options: [
              { value: "log_only", label: "Log only (do nothing)" },
              { value: "send_to_test_phone", label: "Send to test phone" },
            ],
          },
          {
            key: "testPhoneTo",
            label: "Test Phone Number",
            type: "text",
            showWhen: { field: "testBehavior", equals: "send_to_test_phone" },
          },
        ],
        outputFields: [],
      },
      {
        id: "patients/send-message",
        label: "Send Patient Message",
        description: "Message the patient.",
        category: "Patients",
        sideEffect: true,
        configFields: [{ key: "body", label: "Message", type: "text" }],
        outputFields: [],
      },
    ],
  };

  function actionStep(
    id: string,
    config: Record<string, unknown>
  ): WorkflowNode {
    return {
      id,
      position: { x: 0, y: 0 },
      type: "action",
      data: { label: id, type: "action", config },
    };
  }

  it.effect("says what a test run does at each step, from its settings", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [
          lifecycle,
          actionStep("sms default", { actionType: "twilio/send-sms" }),
          actionStep("sms to test phone", {
            actionType: "twilio/send-sms",
            testBehavior: "send_to_test_phone",
            testPhoneTo: "+15557654321",
          }),
          actionStep("sms to empty test phone", {
            actionType: "twilio/send-sms",
            testBehavior: "send_to_test_phone",
          }),
          actionStep("patient message", {
            actionType: "patients/send-message",
          }),
          actionStep("wait", { actionType: BUILT_IN_ACTION_IDS.wait }),
        ],
        catalog: testRunCatalog,
      });

      const topology = yield* tools.read_workflow({});
      const detail = yield* tools.read_nodes({ nodeIds: ["sms default"] });

      expect(
        Object.fromEntries(
          topology.nodes.map((node) => [node.id, node.testRun])
        )
      ).toEqual({
        entry: undefined,
        "sms default":
          'Follows its "In test runs" setting, set to "Log only (do nothing)".',
        "sms to test phone":
          'Follows its "In test runs" setting, set to "Send to test phone". Test Phone Number is "+15557654321".',
        "sms to empty test phone":
          'Follows its "In test runs" setting, set to "Send to test phone". Test Phone Number is empty.',
        "patient message":
          'Has no "In test runs" setting. A test run still calls this step\'s handler, and the action\'s own handler decides whether it does its work; a step it skipped shows as "Skipped (test run)" in that run.',
        wait: "Runs as it does in a live run. It reaches nothing outside the workflow.",
      });
      expect(detail.nodes[0]?.testRun).toContain("Log only (do nothing)");
    })
  );
});

describe("read_nodes", () => {
  it.effect("returns full config for selected nodes", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycle, slackNode],
        edges: [entryToSlack],
        catalog,
      });

      const result = yield* tools.read_nodes({ nodeIds: ["notify"] });

      expect(result.nodes).toEqual([
        {
          id: "notify",
          label: "Notify the team",
          type: "action",
          stepNumber: 1,
          actionType: "slack/send-message",
          testRun: expect.stringContaining('Has no "In test runs" setting'),
          description: "Tell #hiring about the applicant.",
          config: {
            actionType: "slack/send-message",
            integrationId: "conn-1",
            channel: "#hiring",
            text: "New applicant",
          },
        },
      ]);
    })
  );

  it.effect("refuses an unknown requested node", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ nodes: [lifecycle], catalog });

      const failure = yield* Effect.flip(
        tools.read_nodes({ nodeIds: ["missing"] })
      );

      expect(failure.reason).toContain("missing");
    })
  );
});

describe("validate_workflow", () => {
  it.effect("separates whether the draft saves from whether it publishes", () =>
    Effect.gen(function* () {
      const blockers = [
        {
          kind: "missing_integration",
          message: "Connect Slack before publication.",
        },
      ];
      const warnings = [
        {
          kind: "broken_reference",
          message: "A template refers to a deleted node.",
        },
      ];
      const { tools } = yield* agentToolsFor({
        catalog,
        validateDraft: () => ({
          draftValid: true,
          structuralIssues: [],
          publishBlockers: blockers,
          warnings,
        }),
      });

      expect(yield* tools.validate_workflow()).toEqual({
        canSave: true,
        saveIssues: [],
        canPublish: false,
        publishBlockers: blockers,
        warnings,
      });
    })
  );

  it.effect("reports a draft that cannot save as one that cannot publish", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        catalog,
        validateDraft: () => ({
          draftValid: false,
          structuralIssues: ["Graph contains duplicate edge IDs"],
          publishBlockers: [],
          warnings: [],
        }),
      });

      expect(yield* tools.validate_workflow()).toMatchObject({
        canSave: false,
        saveIssues: ["Graph contains duplicate edge IDs"],
        canPublish: false,
      });
    })
  );
});
