import { fireEvent, render, within } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { describe, expect, it } from "vitest";
import { KeyboardShortcutsDialog } from "#src/components/keyboard-shortcuts-dialog";
import { shortcutReferenceOpenAtom } from "#src/lib/shortcut-reference-store";

function renderReference() {
  const store = createStore();
  const view = render(
    <Provider store={store}>
      <KeyboardShortcutsDialog />
    </Provider>
  );
  return { store, view };
}

describe("KeyboardShortcutsDialog", () => {
  it("opens on ? outside a text field, with its search focused", async () => {
    const { view } = renderReference();

    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    const dialog = await view.findByRole("dialog", {
      name: "Keyboard shortcuts",
    });
    const search = within(dialog).getByRole("textbox", {
      name: "Search shortcuts",
    });
    expect(document.activeElement).toBe(search);
    expect(within(dialog).getByText("Open the command palette")).toBeTruthy();
  });

  it("leaves ? to a text field", () => {
    const { store } = renderReference();
    const field = document.createElement("input");
    document.body.append(field);

    fireEvent.keyDown(field, { key: "?", shiftKey: true });
    expect(store.get(shortcutReferenceOpenAtom)).toBe(false);
    field.remove();
  });

  it("filters the rows by what they do", async () => {
    const { store, view } = renderReference();
    store.set(shortcutReferenceOpenAtom, true);

    const search = await view.findByRole("textbox", {
      name: "Search shortcuts",
    });
    fireEvent.change(search, { target: { value: "duplicate" } });
    expect(view.getByText("Duplicate selection")).toBeTruthy();
    expect(view.queryByText("Undo")).toBeNull();

    fireEvent.change(search, { target: { value: "nothing like this" } });
    expect(view.getByText("No shortcut matches that.")).toBeTruthy();
  });
});
