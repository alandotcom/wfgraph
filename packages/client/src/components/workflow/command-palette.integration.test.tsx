import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolbarActions } from "#src/components/workflow/workflow-toolbar-chrome";
import { renderChrome } from "#src/components/workflow/workflow-toolbar-chrome.test-support";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

/**
 * The command palette is mounted by `ToolbarActions`, so what is exercised here
 * is the wiring: the key that opens it, the box in the bar that opens it, the
 * two conditions that refuse it, and the Actions menu item that skips its root
 * page. The page stack itself is pure and lives in `command-palette.test.ts`.
 */
const ONE_ACTION_CATALOG: ExtensionCatalog = {
  events: [],
  integrations: [],
  actions: [
    {
      id: "Wait",
      label: "Wait",
      description: "Delay execution",
      category: "System",
      configFields: [],
      outputFields: [],
    },
  ],
};

/** The palette's own search box, which is the only textbox in this tree. */
function paletteInput(container: HTMLElement | Document = document) {
  return container.querySelector<HTMLInputElement>("[role='combobox']");
}

function pressCommandK(target: Document | Element = document) {
  fireEvent.keyDown(target, { key: "k", metaKey: true });
}

describe("the command palette", () => {
  it("opens on Cmd+K, at the root page", async () => {
    const { findByRole } = renderChrome(ToolbarActions);
    await findByRole("button", { name: "Publish" });

    pressCommandK();

    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search commands, or add a step"
    );
    const palette = document.querySelector('[data-slot="dialog-content"]');
    expect(palette?.className).toContain("data-open:animate-in");
    expect(palette?.className).toContain("motion-reduce:animate-none");
  });

  it("offers workflow and canvas actions", async () => {
    const rendered = renderChrome(ToolbarActions, {
      state: {
        publication: {
          isPublished: true,
          hasUnpublishedChanges: true,
          publishedVersionId: "version_1",
          publishedVersion: 1,
          publishedAt: "2026-08-23T15:00:00.000Z",
        },
      },
    });
    await openedPalette(rendered);

    expect(
      rendered.getByRole("option", { name: /^Save workflow/ })
    ).toBeTruthy();
    expect(
      rendered.getByRole("option", { name: "Go to run history" })
    ).toBeTruthy();
    expect(
      rendered.getByRole("option", { name: "Go to version history" })
    ).toBeTruthy();
    expect(
      rendered.getByRole("option", { name: "Publish workflow" })
    ).toBeTruthy();
    for (const label of [
      /^Fit view/,
      /^Copy selection/,
      /^Paste/,
      /^Duplicate selection/,
      /^Group selection/,
    ]) {
      expect(rendered.getByRole("option", { name: label })).toBeTruthy();
    }

    fireEvent.click(rendered.getByRole("option", { name: /^Save workflow/ }));
    expect(rendered.actions.handleSave).toHaveBeenCalledOnce();

    pressCommandK();
    fireEvent.click(rendered.getByRole("option", { name: "Publish workflow" }));
    expect(rendered.actions.handlePublish).toHaveBeenCalledOnce();

    pressCommandK();
    fireEvent.click(
      rendered.getByRole("option", { name: "Go to run history" })
    );
    expect(rendered.store.get(workflowWorkspaceViewAtom)).toBe("runs");
  });

  // The same rule Cmd+Enter follows: a chord is not worth a keystroke taken out
  // of a field somebody is typing in.
  it("leaves Cmd+K alone while a text field has focus", async () => {
    const { findByRole } = renderChrome(ToolbarActions);
    await findByRole("button", { name: "Publish" });

    const field = document.createElement("input");
    document.body.append(field);
    pressCommandK(field);
    field.remove();

    expect(paletteInput()).toBeNull();
  });

  /**
   * The palette names itself, because none of what it does is legible from a
   * placeholder: that is the weakest source an accessible name can come from,
   * and this one's changes underneath the reader as the page does. The live
   * region is the only signal of that page change that reaches them at all.
   */
  it("names its box, its list, its way out and the page it is on", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    const { getByRole, getByText } = rendered;
    await openedPalette(rendered);

    expect(
      getByRole("combobox", { name: "Search commands and step types" })
    ).toBeTruthy();
    expect(getByRole("listbox", { name: "Commands" })).toBeTruthy();
    // Base UI asks for a close inside every modal popup, for the touch screen
    // reader that has no Escape key and cannot reach the backdrop.
    expect(getByRole("button", { name: "Close command palette" })).toBeTruthy();
    expect(getByText("Commands.").getAttribute("aria-live")).toBe("polite");

    chooseAddStep(rendered);

    expect(
      getByRole("combobox", { name: "Search commands and step types" })
    ).toBeTruthy();
    expect(getByRole("listbox", { name: "Step types" })).toBeTruthy();
    expect(getByText(/^Add step\. Choose/).getAttribute("aria-live")).toBe(
      "polite"
    );
  });

  // The chord is announced once, by `aria-keyshortcuts`. Inside the accessible
  // name the printed `⌘K` read as part of what the button is called.
  it("keeps the printed chord out of the trigger's name", async () => {
    const { findByRole } = renderChrome(ToolbarActions);

    const trigger = await findByRole("button", {
      name: "Search commands or add a step",
    });

    expect(trigger.getAttribute("aria-keyshortcuts")).toMatch(
      /^(Meta|Control)\+K$/
    );
  });

  it("opens from the box in the bar", async () => {
    const { findByRole } = renderChrome(ToolbarActions);

    fireEvent.click(
      await findByRole("button", { name: /Search commands or add a step/ })
    );

    expect(paletteInput()).not.toBeNull();
  });

  // A step added under a run overlay lands on a draft nobody can see, which is
  // the same reason Publish and every menu item that writes the graph refuse.
  it("refuses both ways in while a past run pins the canvas", async () => {
    const { findByRole } = renderChrome(ToolbarActions, {
      overlayActive: true,
    });

    const trigger = await findByRole("button", {
      name: /Search commands or add a step/,
    });
    expect(trigger.hasAttribute("disabled")).toBe(true);

    pressCommandK();

    expect(paletteInput()).toBeNull();
  });

  // Generation used to fall between the palette's lock and its items': Cmd+K
  // opened a palette whose every item was disabled, "Add step" included, which
  // the Actions menu refuses outright in the same state.
  it("refuses both ways in while generation is rewriting the graph", async () => {
    const { findByRole } = renderChrome(ToolbarActions, { generating: true });

    const trigger = await findByRole("button", {
      name: /Search commands or add a step/,
    });
    expect(trigger.hasAttribute("disabled")).toBe(true);

    pressCommandK();

    expect(paletteInput()).toBeNull();
  });

  // Someone who chose "Add step" has already said what they want, so the root
  // page has nothing left to ask them.
  it("sends the Actions menu's Add step straight to the node types", async () => {
    const { findByRole } = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });

    const trigger = await findByRole("button", { name: "Actions" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyUp(trigger, { key: "ArrowDown" });
    fireEvent.click(await findByRole("menuitem", { name: /^Add step/ }));

    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search step types"
    );
    expect(await findByRole("option", { name: /^Wait/ })).toBeTruthy();
  });

  it("shows a non-owner no way into it", async () => {
    const { findByTestId } = renderChrome(ToolbarActions, {
      state: { isOwner: false },
    });
    await findByTestId("toolbar-actions-host");

    pressCommandK();

    expect(paletteInput()).toBeNull();
  });

  // A held palette belongs to the workflow it was opened over. Opening another
  // one throws it away, so returning to the first does not spring it back.
  it("throws the palette away when another workflow opens", async () => {
    const { findByRole, store } = renderChrome(ToolbarActions);
    await findByRole("button", { name: "Publish" });
    act(() => store.set(currentWorkflowIdAtom, "workflow_1"));

    pressCommandK();
    expect(paletteInput()).not.toBeNull();

    act(() => store.set(currentWorkflowIdAtom, "workflow_2"));
    expect(paletteInput()).toBeNull();

    act(() => store.set(currentWorkflowIdAtom, "workflow_1"));
    expect(paletteInput()).toBeNull();
  });

  /**
   * The four paths below are the ones a browser pass walks past. Escape and
   * Backspace already have focus on the input, so they never noticed that the
   * header swaps a `<button>` for an `<svg>` when the last page pops: the
   * element the pointer just acted on unmounts, focus falls to `<body>`, and
   * the dialog's trap parks it on the popup rather than the search box.
   */
  async function openedPalette(
    rendered: Awaited<ReturnType<typeof renderChrome>>
  ) {
    // Anchored at both ends: the Published mode pill's name also starts with
    // "Publish", and this is waiting for the write button beside it.
    await rendered.findByRole("button", { name: /^Publish( v\d+)?$/ });
    pressCommandK();
    const input = paletteInput();
    if (!input) {
      throw new Error("the palette did not open");
    }
    return input;
  }

  /** Take the "Add step" item, which is the way to the second page. */
  function chooseAddStep(rendered: ReturnType<typeof renderChrome>) {
    fireEvent.click(rendered.getByRole("option", { name: /^Add step/ }));
  }

  // An empty list is two different facts and the reader is owed the right one.
  // A host that passed no integrations gets an empty catalog and no error, so
  // this is the surface that has to say which of the two happened.
  it("tells an empty catalog apart from a query that matched nothing", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    const input = await openedPalette(rendered);
    chooseAddStep(rendered);
    fireEvent.change(paletteInput() ?? input, { target: { value: "zzqq" } });

    expect(rendered.getByText("Nothing matches that.")).toBeTruthy();

    rendered.unmount();

    const empty = renderChrome(ToolbarActions);
    await openedPalette(empty);

    chooseAddStep(empty);

    expect(empty.getByText("No step types are available yet.")).toBeTruthy();
  });

  it("hands focus back to the search box when Back is clicked", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    await openedPalette(rendered);
    chooseAddStep(rendered);

    const back = rendered.getByRole("button", { name: "Back to commands" });
    // A pointer press puts focus on the control before the click lands, which
    // is the state that made the swap drop focus out of the palette.
    back.focus();
    fireEvent.click(back);

    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search commands, or add a step"
    );
    expect(document.activeElement).toBe(paletteInput());
  });

  it("goes back a page on Escape, and closes on the next one", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    const input = await openedPalette(rendered);
    chooseAddStep(rendered);

    fireEvent.keyDown(paletteInput() ?? input, { key: "Escape" });
    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search commands, or add a step"
    );

    fireEvent.keyDown(paletteInput() ?? input, { key: "Escape" });
    expect(paletteInput()).toBeNull();
  });

  it("goes back a page on Backspace once the box is empty", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    const input = await openedPalette(rendered);
    chooseAddStep(rendered);

    const onStepPage = paletteInput() ?? input;
    // A Backspace with something to delete stays on the page.
    fireEvent.change(onStepPage, { target: { value: "wa" } });
    fireEvent.keyDown(onStepPage, { key: "Backspace" });
    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search step types"
    );

    fireEvent.change(paletteInput() ?? input, { target: { value: "" } });
    fireEvent.keyDown(paletteInput() ?? input, { key: "Backspace" });
    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search commands, or add a step"
    );
  });

  /**
   * Disabled rows used to set pointer-events: none. Hover then missed the row
   * and looked like leaving the list, so autoHighlight="always" painted the
   * first item. happy-dom does not deliver the pointer path Base UI's list
   * navigation listens for, so the class is what this locks.
   */
  it("lets a disabled row receive the pointer instead of jumping the highlight to the first row", async () => {
    const rendered = renderChrome(ToolbarActions);
    await openedPalette(rendered);

    const undo = rendered.getByRole("option", { name: /^Undo/ });
    expect(undo.getAttribute("data-disabled")).not.toBeNull();
    expect(undo.className).not.toContain("pointer-events-none");
    expect(undo.className).toContain("not-data-disabled");
  });

  it("does not run a disabled command that is clicked", async () => {
    const undo = vi.fn();
    const rendered = renderChrome(ToolbarActions, { state: { undo } });
    await openedPalette(rendered);

    fireEvent.click(rendered.getByRole("option", { name: /^Undo/ }));

    expect(undo).not.toHaveBeenCalled();
    expect(paletteInput()).not.toBeNull();
  });

  it("still highlights an enabled row from the keyboard", async () => {
    const rendered = renderChrome(ToolbarActions);
    const input = await openedPalette(rendered);

    const addStep = rendered.getByRole("option", { name: /^Add step/ });
    const save = rendered.getByRole("option", { name: /^Save workflow/ });

    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(save.hasAttribute("data-highlighted")).toBe(true);
    expect(addStep.hasAttribute("data-highlighted")).toBe(false);
  });

  // The page stack clears the query, and this is that reaching the box the
  // reader is looking at. The pointer is the path: choosing an item is also the
  // moment Base UI would offer the item's own text back as the next value.
  it("empties the box when a page is chosen with the pointer", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    const input = await openedPalette(rendered);

    fireEvent.change(input, { target: { value: "add" } });
    expect(paletteInput()?.value).toBe("add");

    chooseAddStep(rendered);

    expect(paletteInput()?.value).toBe("");
  });
});
