import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { ActionConfigRenderer } from "#src/components/workflow/config/action-config-renderer";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  parseRpcRequestInput,
  rpcJsonResponse,
} from "#src/lib/rpc-fetch-test-support";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { ActionConfigField } from "@wfgraph/shared/plugins/action-fields";

beforeEach(() => {
  installAuthorizationGrantsForTests([
    WfGraphOperations.actionConfigOptions.id,
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAuthorizationGrantsForTests();
});

const templateField: ActionConfigField = {
  key: "emailTemplateId",
  label: "Template",
  type: "provider-select",
  placeholder: "Choose a template",
  optionsSource: { provider: "templates" },
};

const senderField: ActionConfigField = {
  key: "senderId",
  label: "Sender",
  type: "provider-select",
  optionsSource: {
    provider: "senderId",
    parameters: ["emailTemplateId", "senderId"],
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function renderActionFields(options: {
  fields: readonly ActionConfigField[];
  config: Record<string, unknown>;
}) {
  const onUpdateConfig = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  const tree = (config: Record<string, unknown>) => (
    <ExtensionCatalogProvider value={emptyExtensionCatalog}>
      <QueryClientProvider client={queryClient}>
        <ActionConfigRenderer
          config={config}
          fields={options.fields}
          onUpdateConfig={onUpdateConfig}
          owner={{ kind: "action", actionId: "host/template-email" }}
        />
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );
  const view = render(tree(options.config));

  return {
    ...view,
    onUpdateConfig,
    rerenderConfig: (config: Record<string, unknown>) =>
      view.rerender(tree(config)),
  };
}

function renderControlledActionField(options: {
  field: ActionConfigField;
  config: Record<string, unknown>;
  disabled?: boolean;
}) {
  const onUpdateConfig = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });

  function ControlledField({ disabled }: { disabled?: boolean | undefined }) {
    const [config, setConfig] = useState(options.config);
    return (
      <ExtensionCatalogProvider value={emptyExtensionCatalog}>
        <QueryClientProvider client={queryClient}>
          <ActionConfigRenderer
            config={config}
            disabled={disabled}
            fields={[options.field]}
            onUpdateConfig={(patch) => {
              onUpdateConfig(patch);
              setConfig((current) => ({ ...current, ...patch }));
            }}
            owner={{ kind: "action", actionId: "host/template-email" }}
          />
        </QueryClientProvider>
      </ExtensionCatalogProvider>
    );
  }

  const tree = (disabled?: boolean) => <ControlledField disabled={disabled} />;
  const view = render(tree(options.disabled));
  return {
    ...view,
    onUpdateConfig,
    rerenderDisabled: (disabled?: boolean) => view.rerender(tree(disabled)),
  };
}

describe("a host action provider-backed picker", () => {
  it("loads options only through the action endpoint", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        rpcJsonResponse({
          status: "options",
          options: [{ value: "welcome", label: "Welcome" }],
        })
      );

    renderActionFields({ config: {}, fields: [templateField] });

    expect(await screen.findByRole("combobox")).toBeTruthy();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      "/action/configOptions"
    );
    await expect(
      parseRpcRequestInput(fetchSpy.mock.calls[0]?.[1])
    ).resolves.toMatchObject({
      actionId: "host/template-email",
      provider: "templates",
    });
  });

  it("sends the current raw literal draft without waiting for blanks", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        rpcJsonResponse({ status: "options", options: [] })
      );
    const field: ActionConfigField = {
      ...senderField,
      optionsSource: {
        provider: "senderId",
        parameters: ["emailTemplateId", "senderId", "referenceId"],
      },
    };

    renderActionFields({
      config: {
        emailTemplateId: "  welcome  ",
        senderId: "",
        referenceId: "{{@n1:Lead.senderId}}",
        smuggled: "secret",
      },
      fields: [field],
    });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await expect(
      parseRpcRequestInput(fetchSpy.mock.calls[0]?.[1])
    ).resolves.toMatchObject({
      parameters: { emailTemplateId: "  welcome  " },
    });
  });

  it("refreshes dependent choices whenever the draft changes", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        rpcJsonResponse({ status: "options", options: [] })
      );
    const view = renderActionFields({
      config: { emailTemplateId: "", senderId: "" },
      fields: [senderField],
    });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    view.rerenderConfig({ emailTemplateId: "welcome", senderId: "" });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    await expect(
      parseRpcRequestInput(fetchSpy.mock.calls[1]?.[1])
    ).resolves.toMatchObject({
      provider: "senderId",
      parameters: { emailTemplateId: "welcome" },
    });
  });

  it("ignores a stale answer after the draft changes", async () => {
    const oldAnswer = deferred<Response>();
    const currentAnswer = deferred<Response>();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => oldAnswer.promise)
      .mockImplementationOnce(() => currentAnswer.promise);
    const view = renderActionFields({
      config: { emailTemplateId: "old", senderId: "sender_1" },
      fields: [senderField],
    });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    view.rerenderConfig({ emailTemplateId: "new", senderId: "sender_1" });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    currentAnswer.resolve(
      rpcJsonResponse({
        status: "options",
        options: [{ value: "sender_1", label: "Current sender" }],
      })
    );
    expect(await screen.findByRole("combobox")).toBeTruthy();

    oldAnswer.resolve(rpcJsonResponse({ status: "options", options: [] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.onUpdateConfig).not.toHaveBeenCalled();
  });

  it.each(["available", "unavailable", "excluded"] as const)(
    "waits for the fresh %s answer when returning to a cached draft",
    async (outcome) => {
      const freshAnswer = deferred<Response>();
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementationOnce(async () =>
          rpcJsonResponse({ status: "options", options: [] })
        )
        .mockImplementationOnce(async () =>
          rpcJsonResponse({
            status: "options",
            options: [{ value: "sender_1", label: "Other sender" }],
          })
        )
        .mockImplementationOnce(() => freshAnswer.promise);
      const original = { emailTemplateId: "welcome", senderId: "sender_1" };
      const view = renderActionFields({
        config: original,
        fields: [senderField],
      });

      await waitFor(() =>
        expect(view.onUpdateConfig).toHaveBeenCalledWith({ senderId: "" })
      );
      view.rerenderConfig({ ...original, emailTemplateId: "other" });
      await screen.findByRole("combobox");
      view.onUpdateConfig.mockClear();

      view.rerenderConfig(original);
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
      expect(view.onUpdateConfig).not.toHaveBeenCalled();

      freshAnswer.resolve(
        rpcJsonResponse(
          outcome === "unavailable"
            ? {
                status: "unavailable",
                reason: "unreachable",
                message: "Try again later.",
              }
            : {
                status: "options",
                options:
                  outcome === "available"
                    ? [{ value: "sender_1", label: "Current sender" }]
                    : [],
              }
        )
      );
      if (outcome === "excluded") {
        await waitFor(() =>
          expect(view.onUpdateConfig).toHaveBeenCalledExactlyOnceWith({
            senderId: "",
          })
        );
      } else {
        if (outcome === "unavailable") {
          await screen.findByText("Try again later.");
        } else {
          await screen.findByRole("combobox");
        }
        expect(view.onUpdateConfig).not.toHaveBeenCalled();
      }
    }
  );

  it("clears a literal excluded by the latest successful choices once", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        rpcJsonResponse({
          status: "options",
          options: [{ value: "sender_2", label: "Other sender" }],
        })
      );
    const view = renderControlledActionField({
      config: { emailTemplateId: "welcome", senderId: "sender_gone" },
      field: senderField,
    });

    await waitFor(() =>
      expect(view.onUpdateConfig).toHaveBeenCalledWith({ senderId: "" })
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(view.onUpdateConfig).toHaveBeenCalledTimes(1);
  });

  it("keeps an excluded literal while disabled and clears it when enabled", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        rpcJsonResponse({
          status: "options",
          options: [{ value: "sender_2", label: "Other sender" }],
        })
      );
    const view = renderControlledActionField({
      config: { emailTemplateId: "welcome", senderId: "sender_gone" },
      disabled: true,
      field: senderField,
    });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(view.onUpdateConfig).not.toHaveBeenCalled();

    view.rerenderDisabled(false);
    await waitFor(() =>
      expect(view.onUpdateConfig).toHaveBeenCalledExactlyOnceWith({
        senderId: "",
      })
    );
  });

  it("does not clear a template reference or an unavailable selection", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        rpcJsonResponse({
          status: "unavailable",
          reason: "unreachable",
          message: "Try again later.",
        })
      );
    const referenced = renderActionFields({
      config: {
        emailTemplateId: "welcome",
        senderId: "{{@n1:Lead.senderId}}",
      },
      fields: [senderField],
    });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(referenced.onUpdateConfig).not.toHaveBeenCalled();
    referenced.unmount();

    const unavailable = renderActionFields({
      config: { emailTemplateId: "welcome", senderId: "sender_1" },
      fields: [senderField],
    });
    expect(await screen.findByText("Try again later.")).toBeTruthy();
    expect(unavailable.onUpdateConfig).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
