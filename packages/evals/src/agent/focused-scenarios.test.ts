import { describe, expect, it } from "vitest";
import { validateAgentDraft } from "@wfgraph/core/backend/agent/publication-validation";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { AgentDocument } from "@wfgraph/agent/document";
import { focusedScenarios } from "#src/agent/focused-scenarios";
import { assessExpectedCompletion } from "#src/agent/judges/completion";

function eventSplitScenario() {
  const scenario = focusedScenarios.find(
    (candidate) =>
      candidate.name ===
      "builds an Event Split draft with an unspecified channel"
  );
  if (!scenario) {
    throw new Error("The Event Split focused scenario is missing");
  }
  return scenario;
}

function missingIntegrationScenario() {
  const scenario = focusedScenarios.find(
    (candidate) => candidate.name === "reports a missing integration connection"
  );
  if (!scenario) {
    throw new Error("The missing-integration focused scenario is missing");
  }
  return scenario;
}

function unsupportedSmsScenario() {
  const scenario = focusedScenarios.find(
    (candidate) =>
      candidate.name === "does not invent an unavailable SMS action"
  );
  if (!scenario) {
    throw new Error("The unsupported-SMS focused scenario is missing");
  }
  return scenario;
}

function clarificationScenario() {
  const scenario = focusedScenarios.find(
    (candidate) =>
      candidate.name === "asks which Event should start an ambiguous workflow"
  );
  if (!scenario) {
    throw new Error("The clarification focused scenario is missing");
  }
  return scenario;
}

const readyFacts = {
  graphStatus: "ready" as const,
  responseStatus: "answered" as const,
  turnStatus: "completed" as const,
  structuralIssues: [],
  publishBlockers: [],
  warnings: [],
  finalFinishReason: "stop" as const,
};

describe("focused scenarios", () => {
  it("matches the canonical missing-Slack-connection blocker", () => {
    const scenario = missingIntegrationScenario();
    const expectedCompletion = scenario.input.expectedCompletion;
    if (expectedCompletion.outcome !== "blocked") {
      throw new Error("The missing-integration scenario must expect a blocker");
    }

    expect(expectedCompletion.requiredPublishBlocker).toEqual({
      kind: "missing_integration",
      messageMustMention: ["needs a Slack connection"],
    });
    expect(expectedCompletion.allowedPublishBlockerKinds).toEqual([
      "missing_integration",
    ]);
    expect(expectedCompletion.answerMustMention).toEqual([
      "Slack",
      "connection",
    ]);
    expect(
      assessExpectedCompletion({
        expected: expectedCompletion,
        finalText: "The draft requires a Slack connection before publishing.",
        facts: {
          ...readyFacts,
          graphStatus: "blocked",
          publishBlockers: [
            {
              kind: "missing_integration",
              message:
                'Node "Notify recruiting" needs a Slack connection before publishing.',
            },
          ],
        },
      })
    ).toMatchObject({ score: 1 });
  });

  it("requires the unsupported SMS answer to name the requested channel", () => {
    const scenario = unsupportedSmsScenario();
    const expectedCompletion = scenario.input.expectedCompletion;
    if (expectedCompletion.outcome !== "unsupported") {
      throw new Error(
        "The unsupported-SMS scenario must expect unsupported work"
      );
    }

    expect(expectedCompletion.answerMustMentionOneOf).toEqual([
      "SMS",
      "text message",
      "texting",
    ]);
    expect(
      assessExpectedCompletion({
        expected: expectedCompletion,
        finalText: "No texting/SMS action is available, so I can’t build this.",
        facts: readyFacts,
      })
    ).toMatchObject({ score: 1 });
  });

  it("accepts one clarification question followed by an Event catalog", () => {
    const scenario = clarificationScenario();
    const expectedCompletion = scenario.input.expectedCompletion;
    if (expectedCompletion.outcome !== "clarification") {
      throw new Error("The clarification scenario must expect a clarification");
    }

    expect(
      assessExpectedCompletion({
        expected: expectedCompletion,
        finalText:
          "Which Event should start the applicant follow-up workflow?\n\nAvailable Events:\n- applicant.created\n- applicant.withdrawn",
        facts: readyFacts,
      })
    ).toMatchObject({ score: 1 });
  });

  it("matches the canonical missing-channel blocker for the Event Split draft", () => {
    const scenario = eventSplitScenario();
    const expectedEvents = scenario.input.expected.exactEvents?.start;
    if (!expectedEvents) {
      throw new Error("The Event Split focused scenario has no Start Events");
    }
    const [createdEvent, rescheduledEvent] = expectedEvents;
    if (!createdEvent || !rescheduledEvent) {
      throw new Error(
        "The Event Split focused scenario needs two Start Events"
      );
    }
    const expectedCompletion = scenario.input.expectedCompletion;
    if (expectedCompletion.outcome !== "blocked") {
      throw new Error("The Event Split focused scenario must expect a blocker");
    }

    expect(expectedCompletion.requiredPublishBlocker).toEqual({
      kind: "missing_required_field",
      messageMustMention: ["missing required field", "channel"],
    });
    expect(expectedCompletion.allowedPublishBlockerKinds).toEqual([
      "missing_required_field",
    ]);

    const document: AgentDocument = {
      nodes: [
        ...scenario.input.document.nodes,
        {
          id: "entry",
          type: "lifecycle",
          position: { x: 0, y: 0 },
          data: {
            label: "Lifecycle",
            type: "lifecycle",
            config: {
              lifecycleRules: {
                startEvents: [createdEvent, rescheduledEvent],
                cancelEvents: [],
                concurrency: "unlimited",
              },
            },
          },
        },
        {
          id: "split",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "Event Split",
            type: "action",
            config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
          },
        },
        {
          id: "created-message",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "Created message",
            type: "action",
            config: {
              actionType: "slack/send-message",
              integrationId: "slack-primary",
              text: "Appointment created at {{@entry:Lifecycle.appointment.startsAt}}",
            },
          },
        },
        {
          id: "rescheduled-message",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "Rescheduled message",
            type: "action",
            config: {
              actionType: "slack/send-message",
              integrationId: "slack-primary",
              text: "Appointment rescheduled for {{@entry:Lifecycle.appointment.startsAt}}",
            },
          },
        },
      ],
      edges: [
        {
          id: "entry-split",
          source: "entry",
          target: "split",
          sourceHandle: "started",
        },
        {
          id: "created-message",
          source: "split",
          target: "created-message",
          sourceHandle: `event:${createdEvent}`,
        },
        {
          id: "rescheduled-message",
          source: "split",
          target: "rescheduled-message",
          sourceHandle: `event:${rescheduledEvent}`,
        },
      ],
    };

    const validation = validateAgentDraft({
      document,
      catalog: scenario.input.catalog,
      integrations: scenario.input.integrations,
    });

    expect(
      validation.publishBlockers.every((blocker) =>
        expectedCompletion.allowedPublishBlockerKinds.some(
          (allowedKind) => allowedKind === blocker.kind
        )
      )
    ).toBe(true);
    expect(
      validation.publishBlockers.some(
        (blocker) =>
          blocker.kind === expectedCompletion.requiredPublishBlocker.kind &&
          expectedCompletion.requiredPublishBlocker.messageMustMention.every(
            (term) =>
              blocker.message
                .toLocaleLowerCase()
                .includes(term.toLocaleLowerCase())
          )
      )
    ).toBe(true);
  });
});
