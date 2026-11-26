import { afterEach, describe, expect, it } from "vitest";
import {
  editorChordAllowed,
  keyboardLayerOpen,
} from "#src/lib/editor-shortcuts";

function keyDownOn(target: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "z", metaKey: true });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("editorChordAllowed", () => {
  it("lets a canvas chord run from the page and skip a text field", () => {
    const field = document.createElement("input");
    document.body.append(field);

    expect(
      editorChordAllowed(keyDownOn(document.body), { inTextFields: false })
    ).toBe(true);
    expect(editorChordAllowed(keyDownOn(field), { inTextFields: false })).toBe(
      false
    );
    expect(editorChordAllowed(keyDownOn(field), { inTextFields: true })).toBe(
      true
    );
  });

  it.each([
    ["a modal overlay", '<div role="dialog" aria-modal="true"></div>'],
    ["a Base UI dialog", '<div data-slot="dialog-content"></div>'],
    ["an alert dialog", '<div data-slot="alert-dialog-content"></div>'],
    ["a menu", '<div data-slot="dropdown-menu-content"></div>'],
    ["the canvas context menu", '<div data-slot="canvas-context-menu"></div>'],
  ])("holds every chord while %s is open", (_name, markup) => {
    document.body.innerHTML = markup;

    expect(keyboardLayerOpen()).toBe(true);
    expect(
      editorChordAllowed(keyDownOn(document.body), { inTextFields: true })
    ).toBe(false);
  });

  it("does not count a non-modal region as a layer", () => {
    document.body.innerHTML = '<div aria-modal="false"></div>';

    expect(keyboardLayerOpen()).toBe(false);
  });
});
