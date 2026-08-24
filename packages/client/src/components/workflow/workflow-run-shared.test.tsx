import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { IntegrationUi } from "@wfgraph/plugins/ui";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import {
  JsonPropertyInspector,
  OutputDisplay,
} from "#src/components/workflow/workflow-run-shared";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const testCatalog: ExtensionCatalog = {
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
};

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
    <ExtensionCatalogProvider value={testCatalog}>
      <IntegrationUiProvider value={SLACK_UI}>
        <OutputDisplay actionType={actionType} output={{ ok: true }} />
      </IntegrationUiProvider>
    </ExtensionCatalogProvider>
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

  it("shows a friendly property inspector when an action has no custom result", () => {
    const view = renderOutput("slack/notify");

    expect(view.getByText("Ok")).toBeTruthy();
    expect(view.getByText("Yes")).toBeTruthy();
    expect(view.queryByText(/"ok"/)).toBeNull();
  });
});

describe("JsonPropertyInspector", () => {
  it("humanizes keys and formats common scalar values", () => {
    const view = render(
      <JsonPropertyInspector
        value={{
          appointment_url: "https://example.com/appointments/42",
          isConfirmed: true,
          note: "",
          retryCount: 3,
        }}
      />
    );

    expect(view.getByText("Appointment URL")).toBeTruthy();
    expect(view.getByRole("link", { name: /example.com/ })).toBeTruthy();
    expect(view.getByText("Is Confirmed")).toBeTruthy();
    expect(view.getByText("Yes")).toBeTruthy();
    expect(view.getByText("Empty")).toBeTruthy();
    expect(view.getByText("3").className).toContain("tabular-nums");
  });

  it("preserves line breaks and repeated whitespace in string values", () => {
    const value = "First line\n  second  line";
    const view = render(<JsonPropertyInspector value={value} />);

    const scalar = view.getByText(
      (_, element) =>
        element?.tagName === "SPAN" && element.textContent === value
    );

    expect(scalar.className).toContain("whitespace-pre-wrap");
  });

  it("preserves surrounding whitespace in URL-shaped string values", () => {
    const value = "  https://example.com/a  ";
    const view = render(<JsonPropertyInspector value={value} />);

    const scalar = view.getByText(
      (_, element) =>
        element?.tagName === "SPAN" && element.textContent === value
    );

    expect(scalar.className).toContain("whitespace-pre-wrap");
    expect(view.queryByRole("link")).toBeNull();
  });

  it("keeps nested collections behind explicit disclosures", () => {
    const view = render(
      <JsonPropertyInspector
        value={{
          customer: { id: "cus_1", preferences: { locale: "en" } },
          deliveries: [{ id: "del_1" }, { id: "del_2" }, { id: "del_3" }],
        }}
      />
    );

    expect(view.queryByText("cus_1")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: /Customer.*2 fields/ }));
    expect(view.getByText("cus_1")).toBeTruthy();
    expect(view.queryByText("en")).toBeNull();
    expect(
      view.getByRole("button", { name: /Deliveries.*3 items/ })
    ).toBeTruthy();
  });

  it("opens collection content without a restartable entrance animation", () => {
    const view = render(
      <JsonPropertyInspector value={{ customer: { id: "cus_1" } }} />
    );

    fireEvent.click(view.getByRole("button", { name: /Customer.*1 field/ }));

    expect(view.container.innerHTML).not.toContain("run-disclosure");
  });
});
