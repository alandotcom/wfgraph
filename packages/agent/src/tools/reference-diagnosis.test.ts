import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import { emptyLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import type { AgentDocument } from "#src/document";
import { fixtureCatalog } from "#src/tools/catalog-fixture";
import {
  brokenReferencesIn,
  explainArrivingEventChange,
  referencesBrokenBetween,
} from "#src/tools/reference-diagnosis";

const catalog = fixtureCatalog;

const entry: WorkflowNode = {
  id: "entry",
  type: "lifecycle",
  position: { x: 0, y: 0 },
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

/** A Wait that is a plain delay until a case turns it into an Event wait. */
const delayWait: WorkflowNode = {
  id: "wait",
  type: "action",
  position: { x: 0, y: 0 },
  data: {
    label: "Hold",
    type: "action",
    config: { actionType: BUILT_IN_ACTION_IDS.wait, waitMode: "delay" },
  },
};

const eventWait: WorkflowNode = {
  ...delayWait,
  data: {
    ...delayWait.data,
    config: {
      actionType: BUILT_IN_ACTION_IDS.wait,
      waitMode: "event",
      waitFor: [{ event: "applicant.withdrawn" }],
      waitTimeout: "7d",
      waitTimeoutBehavior: "continue",
    },
  },
};

/** A step below the Wait reading a Start Event path off the Lifecycle Node. */
const notify: WorkflowNode = {
  id: "notify",
  type: "action",
  position: { x: 0, y: 0 },
  data: {
    label: "Notify the team",
    type: "action",
    config: {
      actionType: "slack/send-message",
      integrationId: "conn-1",
      channel: "#team",
      text: "Reach {{@entry:Lifecycle.email}}",
    },
  },
};

const edges = [
  {
    id: "e1",
    source: "entry",
    target: "wait",
    sourceHandle: LIFECYCLE_STARTED_HANDLE,
  },
  { id: "e2", source: "wait", target: "notify" },
];

const beforeTheWait: AgentDocument = {
  nodes: [entry, delayWait, notify],
  edges,
};
const afterTheWait: AgentDocument = {
  nodes: [entry, eventWait, notify],
  edges,
};

describe("brokenReferencesIn", () => {
  it("reports nothing while the token still resolves", () => {
    expect(brokenReferencesIn({ document: beforeTheWait, catalog })).toEqual(
      []
    );
  });

  it("reports a token the Arriving Event change stranded", () => {
    expect(brokenReferencesIn({ document: afterTheWait, catalog })).toEqual([
      {
        nodeId: "notify",
        nodeLabel: "Notify the team",
        configKey: "text",
        token: "{{@entry:Lifecycle.email}}",
      },
    ]);
  });

  it("leaves a token naming a whole upstream output alone", () => {
    const wholeOutput: AgentDocument = {
      nodes: [
        entry,
        eventWait,
        {
          ...notify,
          data: {
            ...notify.data,
            config: { ...notify.data.config, text: "{{@entry:Lifecycle}}" },
          },
        },
      ],
      edges,
    };

    expect(brokenReferencesIn({ document: wholeOutput, catalog })).toEqual([]);
  });
});

describe("referencesBrokenBetween", () => {
  it("reports only what this edit broke", () => {
    const broken = referencesBrokenBetween({
      before: beforeTheWait,
      after: afterTheWait,
      catalog,
    });

    expect(broken).toHaveLength(1);
    expect(broken[0]?.nodeId).toBe("notify");
  });

  it("stays quiet about a token that was already broken", () => {
    const broken = referencesBrokenBetween({
      before: afterTheWait,
      after: afterTheWait,
      catalog,
    });

    expect(broken).toEqual([]);
  });
});

describe("explainArrivingEventChange", () => {
  it("names the Wait and the Events it put in the way", () => {
    const explanation = explainArrivingEventChange({
      token: "{{@entry:Lifecycle.email}}",
      nodeId: "notify",
      document: afterTheWait,
      catalog,
    });

    expect(explanation).toContain("Hold");
    expect(explanation).toContain("applicant.withdrawn");
  });

  it("says nothing when no Event wait sits between the two steps", () => {
    expect(
      explainArrivingEventChange({
        token: "{{@entry:Lifecycle.email}}",
        nodeId: "notify",
        document: beforeTheWait,
        catalog,
      })
    ).toBeUndefined();
  });
});
