/**
 * The two provider-backed controls, driven through the renderer switchboard so
 * the `FIELD_RENDERERS` wiring is covered along with the components.
 *
 * The one invariant they share: whatever the connection says, the builder can
 * still type the value themselves.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionConfigRenderer } from "#src/components/workflow/config/action-config-renderer";
import type { ConfigOptionsAnswer } from "#src/lib/rpc-client";
import { configOptionsQueryOptions } from "#src/lib/rpc-query";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { ActionConfigField } from "@wfgraph/shared/plugins/action-fields";

afterEach(() => {
  vi.restoreAllMocks();
});

const templateField: ActionConfigField = {
  key: "emailTemplateId",
  label: "Template",
  type: "provider-select",
  placeholder: "Choose a template",
  optionsSource: { provider: "templates" },
};

const variablesField: ActionConfigField = {
  key: "emailTemplateVariables",
  label: "Template Variables",
  type: "provider-fields",
  optionsSource: {
    provider: "template-variables",
    parameters: ["emailTemplateId"],
  },
};

function renderFields(options: {
  fields: readonly ActionConfigField[];
  config: Record<string, unknown>;
  seed?: Array<{
    provider: string;
    parameters?: Record<string, string>;
    answer: ConfigOptionsAnswer;
  }>;
}) {
  const onUpdateConfig = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });

  for (const entry of options.seed ?? []) {
    queryClient.setQueryData(
      configOptionsQueryOptions({
        integrationId: String(options.config.integrationId),
        provider: entry.provider,
        parameters: entry.parameters ?? {},
      }).queryKey,
      entry.answer
    );
  }

  const { unmount } = render(
    <ExtensionCatalogProvider value={emptyExtensionCatalog}>
      <QueryClientProvider client={queryClient}>
        <ActionConfigRenderer
          config={options.config}
          fields={options.fields}
          onUpdateConfig={onUpdateConfig}
        />
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );

  return { onUpdateConfig, unmount };
}

describe("a provider-backed picker", () => {
  it("falls back to a typed value when the node names no connection", () => {
    renderFields({ config: {}, fields: [templateField] });

    // No connection to ask, so the plain control stands in rather than a
    // dropdown that could never be filled.
    expect(screen.getByLabelText("Template")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("lists what the connection answered", () => {
    renderFields({
      config: { integrationId: "int_1" },
      fields: [templateField],
      seed: [
        {
          provider: "templates",
          answer: {
            status: "options",
            options: [
              { value: "tpl_1", label: "Welcome" },
              { value: "tpl_2", label: "Reminder (draft)" },
            ],
          },
        },
      ],
    });

    expect(screen.getByRole("combobox")).toBeTruthy();
  });

  it("still shows a stored value the connection no longer lists", () => {
    renderFields({
      config: { integrationId: "int_1", emailTemplateId: "tpl_gone" },
      fields: [templateField],
      seed: [
        {
          provider: "templates",
          answer: { status: "options", options: [] },
        },
      ],
    });

    // Reading as empty would hide what the node actually sends.
    expect(screen.getByText("tpl_gone")).toBeTruthy();
  });

  it("edits a node reference as a template rather than a choice", () => {
    renderFields({
      config: {
        integrationId: "int_1",
        emailTemplateId: "{{@n1:Lead.templateId}}",
      },
      fields: [templateField],
      seed: [
        {
          provider: "templates",
          answer: { status: "options", options: [] },
        },
      ],
    });

    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("keeps one row height across every state it can be in", () => {
    // The toggle sits beside the control, and the two controls are different
    // heights, so without a floor on the row the whole panel below jumps each
    // time it is pressed.
    const rowClass = (): string | undefined =>
      screen.getByRole("button", {
        name: /upstream value|Choose from the connection/u,
      }).parentElement?.className;

    const { unmount } = renderFields({
      config: { integrationId: "int_1" },
      fields: [templateField],
      seed: [
        {
          provider: "templates",
          answer: {
            status: "options",
            options: [{ value: "tpl_1", label: "Welcome" }],
          },
        },
      ],
    });
    const picking = rowClass();
    expect(picking).toContain("min-h-7");

    fireEvent.click(screen.getByRole("button", { name: /upstream value/u }));
    expect(rowClass()).toBe(picking);
    unmount();

    renderFields({ config: {}, fields: [templateField] });
    expect(rowClass()).toBe(picking);
  });

  it("switches to the template editor and back again", () => {
    const { onUpdateConfig } = renderFields({
      config: { integrationId: "int_1" },
      fields: [templateField],
      seed: [
        {
          provider: "templates",
          answer: {
            status: "options",
            options: [{ value: "tpl_1", label: "Welcome" }],
          },
        },
      ],
    });

    expect(screen.getByRole("combobox")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /upstream value/u }));

    // Deriving the mode from the value alone cannot represent "about to type a
    // reference", so this direction did nothing until it became state.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(onUpdateConfig).toHaveBeenCalledWith({ emailTemplateId: "" });

    fireEvent.click(
      screen.getByRole("button", { name: /Choose from the connection/u })
    );
    expect(screen.getByRole("combobox")).toBeTruthy();
  });

  it("shows the integration's own sentence when access is the problem", () => {
    renderFields({
      config: { integrationId: "int_1" },
      fields: [templateField],
      seed: [
        {
          provider: "templates",
          answer: {
            status: "unavailable",
            reason: "not_permitted",
            message: "This connection cannot read templates.",
          },
        },
      ],
    });

    // The integration wrote this, so it is safe to draw and it is the sentence
    // that says what to do. The plain control stays live underneath.
    expect(
      screen.getByText("This connection cannot read templates.")
    ).toBeTruthy();
    expect(screen.getByLabelText("Template")).toBeTruthy();
  });

  it("never renders what a failed request's own exception carried", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("GET https://api.vendor.example/templates?api_key=re_secret")
    );

    renderFields({
      config: { integrationId: "int_1" },
      fields: [templateField],
    });

    await waitFor(() =>
      expect(
        screen.getByText("Could not read this from the connection.")
      ).toBeTruthy()
    );
    // The only string available is the vendor's exception, which nobody audited
    // and which can carry a request URL holding a credential.
    expect(screen.queryByText(/re_secret/u)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("a provider-backed field set", () => {
  const withTemplate = {
    integrationId: "int_1",
    emailTemplateId: "tpl_1",
  };

  const variablesAnswer: ConfigOptionsAnswer = {
    status: "fields",
    fields: [
      { key: "FIRST_NAME", label: "FIRST_NAME" },
      {
        key: "LOCATION",
        label: "LOCATION",
        defaultValue: "Burbank, CA",
      },
    ],
  };

  const seedVariables = [
    {
      provider: "template-variables",
      parameters: { emailTemplateId: "tpl_1" },
      answer: variablesAnswer,
    },
  ];

  it("draws one input per declared value, prefilled with its default", () => {
    renderFields({
      config: withTemplate,
      fields: [variablesField],
      seed: seedVariables,
    });

    expect(screen.getByLabelText("FIRST_NAME")).toBeTruthy();
    expect(screen.getByText("Burbank, CA")).toBeTruthy();
  });

  it("writes one JSON object under the one config key", () => {
    const { onUpdateConfig } = renderFields({
      config: withTemplate,
      fields: [variablesField],
      seed: seedVariables,
    });

    fireEvent.input(screen.getByLabelText("FIRST_NAME"), {
      target: { textContent: "Ada" },
    });

    const written = onUpdateConfig.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(written).toBeDefined();
    expect(Object.keys(written ?? {})).toEqual(["emailTemplateVariables"]);
    // A prefilled input the builder never touched stays out, so the provider
    // applies its own fallback.
    expect(JSON.parse(String(written?.emailTemplateVariables))).toEqual({
      FIRST_NAME: "Ada",
    });
  });

  it("keeps and names values the current selection no longer declares", () => {
    const { onUpdateConfig } = renderFields({
      config: {
        ...withTemplate,
        emailTemplateVariables: JSON.stringify({ OLD_KEY: "kept" }),
      },
      fields: [variablesField],
      seed: seedVariables,
    });

    expect(
      screen.getByText("Kept but not used by this selection: OLD_KEY")
    ).toBeTruthy();

    fireEvent.input(screen.getByLabelText("FIRST_NAME"), {
      target: { textContent: "Ada" },
    });

    // Editing must not discard it one render after saying it was kept: switching
    // selections is something the builder can undo.
    const written = onUpdateConfig.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(JSON.parse(String(written?.emailTemplateVariables))).toEqual({
      OLD_KEY: "kept",
      FIRST_NAME: "Ada",
    });
  });

  it("treats stored reserved keys as raw data that must be repaired", () => {
    renderFields({
      config: {
        ...withTemplate,
        emailTemplateVariables: '{"__proto__":"kept"}',
      },
      fields: [variablesField],
      seed: seedVariables,
    });

    expect(screen.queryByLabelText("FIRST_NAME")).toBeNull();
    expect(screen.getByLabelText("Template Variables").textContent).toBe(
      '{"__proto__":"kept"}'
    );
  });

  it("stores an input cleared away from its default", () => {
    const { onUpdateConfig } = renderFields({
      config: withTemplate,
      fields: [variablesField],
      seed: seedVariables,
    });

    fireEvent.input(screen.getByLabelText("LOCATION"), {
      target: { textContent: "" },
    });

    // "Send nothing here" is a different instruction from "use the default",
    // and only the second one is an absent key.
    const written = onUpdateConfig.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(JSON.parse(String(written?.emailTemplateVariables))).toEqual({
      LOCATION: "",
    });
  });

  it("keeps a declared number a number", () => {
    const { onUpdateConfig } = renderFields({
      config: withTemplate,
      fields: [variablesField],
      seed: [
        {
          provider: "template-variables",
          parameters: { emailTemplateId: "tpl_1" },
          answer: {
            status: "fields",
            fields: [{ key: "RETRIES", label: "RETRIES", type: "number" }],
          },
        },
      ],
    });

    fireEvent.input(screen.getByLabelText("RETRIES"), {
      target: { textContent: "3" },
    });

    const written = onUpdateConfig.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(JSON.parse(String(written?.emailTemplateVariables))).toEqual({
      RETRIES: 3,
    });
  });

  it("marks a variable the template has no default for", () => {
    renderFields({
      config: withTemplate,
      fields: [variablesField],
      seed: [
        {
          provider: "template-variables",
          parameters: { emailTemplateId: "tpl_1" },
          answer: {
            status: "fields",
            fields: [
              { key: "FIRST_NAME", label: "FIRST_NAME", required: true },
              { key: "CITY", label: "CITY", defaultValue: "Burbank" },
            ],
          },
        },
      ],
    });

    // Resend refuses the send without it, so the empty box says so where the
    // builder is looking rather than waiting for the run to fail.
    expect(screen.getByText(/no default for FIRST_NAME/u)).toBeTruthy();
    expect(screen.queryByText(/no default for CITY/u)).toBeNull();
  });

  it("stops marking it once a value is there", () => {
    renderFields({
      config: {
        ...withTemplate,
        emailTemplateVariables: JSON.stringify({ FIRST_NAME: "Ada" }),
      },
      fields: [variablesField],
      seed: [
        {
          provider: "template-variables",
          parameters: { emailTemplateId: "tpl_1" },
          answer: {
            status: "fields",
            fields: [
              { key: "FIRST_NAME", label: "FIRST_NAME", required: true },
            ],
          },
        },
      ],
    });

    expect(screen.queryByText(/no default for FIRST_NAME/u)).toBeNull();
  });

  it("keeps a hand-written value that is not a JSON object", () => {
    renderFields({
      config: { ...withTemplate, emailTemplateVariables: "not json" },
      fields: [variablesField],
      seed: seedVariables,
    });

    // Rendering the form over it would discard what the builder typed.
    expect(screen.getByText("not json")).toBeTruthy();
    expect(screen.queryByLabelText("FIRST_NAME")).toBeNull();
  });

  it("waits for the template before asking what its values are", () => {
    renderFields({
      config: { integrationId: "int_1" },
      fields: [variablesField],
    });

    expect(screen.getByLabelText("Template Variables")).toBeTruthy();
    expect(screen.queryByLabelText("FIRST_NAME")).toBeNull();
  });
});
