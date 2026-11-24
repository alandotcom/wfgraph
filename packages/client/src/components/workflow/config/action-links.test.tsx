import { fireEvent, render, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { ActionLinks } from "#src/components/workflow/config/action-links";
import {
  autosaveDelayAtom,
  currentWorkflowIdAtom,
  saveWorkflowAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import {
  savedWorkflow,
  unreadableDraft,
} from "#src/lib/workflow-save-test-support";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const catalog: ExtensionCatalog = {
  events: [],
  entities: [],
  actions: [
    {
      id: "members/send-email",
      label: "Send Email to Member",
      description: "Sends an email",
      category: "Members",
      links: [
        {
          label: "Preview email",
          url: "/email-preview?workflow={workflowId}&node={nodeId}",
        },
        { label: "Template guide", url: "https://app.example.com/guide" },
      ],
      configFields: [],
      outputFields: [],
    },
    {
      id: "members/tag",
      label: "Tag Member",
      description: "Tags a member",
      category: "Members",
      configFields: [],
      outputFields: [],
    },
  ],
  integrations: [],
};

/**
 * The links of `actionId` for node `nodeId` of workflow `workflowId`, over a
 * store whose autosave waits a minute, so an edit stays on the timer until
 * something sends it early.
 */
function renderLinks(input: {
  actionId: string;
  workflowId?: string;
  nodeId?: string;
}) {
  const update = vi.fn(async () => savedWorkflow("wf_1"));
  const store = createStore();
  store.set(autosaveDelayAtom, 60_000);
  store.set(workflowApiAtom, { update, read: unreadableDraft });
  store.set(currentWorkflowIdAtom, input.workflowId ?? "wf_1");

  const view = render(
    <ExtensionCatalogProvider value={catalog}>
      <JotaiProvider store={store}>
        <ActionLinks actionId={input.actionId} nodeId={input.nodeId ?? "n_1"} />
      </JotaiProvider>
    </ExtensionCatalogProvider>
  );
  return { view, store, update };
}

/**
 * Clicks `element` with `button`, the primary button unless a middle click is
 * asked for, and answers whether anything before the document, such as
 * the component's own handler, prevented the navigation. The document then
 * prevents it, so happy-dom opens no window and fetches nothing.
 */
function clickWithoutNavigating(
  element: HTMLElement,
  button: "primary" | "middle" = "primary"
): {
  preventedByComponent: boolean;
} {
  // A browser sends a middle click as an auxclick, with button 1.
  const eventType = button === "middle" ? "auxclick" : "click";
  let preventedByComponent = false;
  const stop = (event: Event) => {
    preventedByComponent = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener(eventType, stop);
  if (button === "middle") {
    fireEvent(
      element,
      new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })
    );
  } else {
    fireEvent.click(element);
  }
  document.removeEventListener(eventType, stop);
  return { preventedByComponent };
}

describe("ActionLinks", () => {
  it("fills the workflow and node ids into each link, encoded", () => {
    const { view } = renderLinks({
      actionId: "members/send-email",
      workflowId: "wf 1",
      nodeId: "node/1&x",
    });

    const preview = view.getByRole("link", { name: "Preview email" });
    expect(preview.getAttribute("href")).toBe(
      "/email-preview?workflow=wf%201&node=node%2F1%26x"
    );
    expect(
      view.getByRole("link", { name: "Template guide" }).getAttribute("href")
    ).toBe("https://app.example.com/guide");
  });

  it("opens each link in a new tab with no opener and no referrer", () => {
    const { view } = renderLinks({ actionId: "members/send-email" });

    for (const link of view.getAllByRole("link")) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("draws no list for an action that declares no links", () => {
    const { view } = renderLinks({ actionId: "members/tag" });

    expect(view.queryByRole("list")).toBeNull();
    expect(view.queryByRole("link")).toBeNull();
  });

  // The host's page reads the saved draft, so an edit still on the autosave
  // timer would be missing from it. Following the link sends that edit at once.
  it.each(["primary", "middle"] as const)(
    "sends the edit waiting on the autosave timer on a %s click",
    async (button) => {
      const { view, store, update } = renderLinks({
        actionId: "members/send-email",
      });
      void store.set(saveWorkflowAtom, { name: "Member welcome" });
      expect(update).not.toHaveBeenCalled();

      const { preventedByComponent } = clickWithoutNavigating(
        view.getByRole("link", { name: "Preview email" }),
        button
      );

      expect(preventedByComponent).toBe(false);
      await waitFor(() => {
        expect(update).toHaveBeenCalledTimes(1);
      });
    }
  );

  // A browser reads a whole path segment of `..` as a step up the path, so a
  // link for such a node would open another page of the host's.
  it("leaves out a link whose url cannot be filled for the node", () => {
    const { view } = renderLinks({
      actionId: "members/send-email",
      nodeId: "..",
    });

    expect(view.queryByRole("list")).toBeNull();
    expect(view.queryByRole("link")).toBeNull();
  });

  it("sends nothing when a link is clicked with no edit waiting", async () => {
    const { view, update } = renderLinks({ actionId: "members/send-email" });

    clickWithoutNavigating(view.getByRole("link", { name: "Preview email" }));
    await Promise.resolve();

    expect(update).not.toHaveBeenCalled();
  });
});
