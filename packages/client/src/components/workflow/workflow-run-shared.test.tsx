import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IntegrationUi } from "@wfgraph/plugins/ui";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OutputDisplay } from "#src/components/workflow/workflow-run-shared";
import { putExtensionCatalog } from "#src/lib/extensions";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

/**
 * Three actions the renderer lookup has to tell apart: one Slack owns, one a
 * host defined under a Slack-looking id, and one whose id carries no owner
 * prefix at all.
 */
beforeEach(() => {
  putExtensionCatalog({
    events: [],
    integrations: [],
    actions: [
      {
        id: "slack/post-message",
        label: "Post message",
        description: "Post to a channel",
        category: "messaging",
        integration: "slack",
        configFields: [],
        outputFields: [],
      },
      {
        id: "slack/notify",
        label: "Notify",
        description: "A host action, owned by no integration",
        category: "messaging",
        configFields: [],
        outputFields: [],
      },
      {
        id: "post-message",
        label: "Unprefixed",
        description: "Claims Slack as its owner without wearing the prefix",
        category: "messaging",
        integration: "slack",
        configFields: [],
        outputFields: [],
      },
    ],
  });
});

afterEach(() => {
  putExtensionCatalog(emptyExtensionCatalog);
});

const SLACK_UI: Record<string, IntegrationUi> = {
  slack: {
    icon: () => null,
    outputComponents: {
      "post-message": () => <div>slack renderer</div>,
    },
  },
};

function renderOutput(actionType: string) {
  return render(
    <IntegrationUiProvider value={SLACK_UI}>
      <OutputDisplay actionType={actionType} output={{ ok: true }} />
    </IntegrationUiProvider>
  );
}

describe("OutputDisplay", () => {
  it("renders the integration's own component for an action it owns", () => {
    const view = renderOutput("slack/post-message");

    expect(view.queryByText("slack renderer")).not.toBeNull();
  });

  it("leaves a host action under a matching id to plain JSON", () => {
    const view = renderOutput("slack/notify");

    expect(view.queryByText("slack renderer")).toBeNull();
  });

  it("leaves an id missing its owner's prefix to plain JSON", () => {
    const view = renderOutput("post-message");

    expect(view.queryByText("slack renderer")).toBeNull();
  });
});
