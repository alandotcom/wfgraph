import { afterEach, describe, expect, it } from "vitest";
import {
  dialogFinalFocus,
  focusOpener,
  recordFocusOpener,
} from "#src/lib/focus-return";

afterEach(() => {
  document.body.replaceChildren();
  recordFocusOpener(document.body);
});

function button(name: string, parent: HTMLElement = document.body) {
  const element = document.createElement("button");
  element.textContent = name;
  parent.append(element);
  return element;
}

describe("recordFocusOpener", () => {
  it("records the control a press lands in", () => {
    const publish = button("Publish");
    const icon = document.createElement("span");
    publish.append(icon);

    recordFocusOpener(icon);
    expect(focusOpener()).toBe(publish);
  });

  it("ignores presses inside a dialog, menu or palette", () => {
    const publish = button("Publish");
    recordFocusOpener(publish);
    const dialog = document.createElement("div");
    dialog.dataset.slot = "dialog-content";
    document.body.append(dialog);

    recordFocusOpener(button("Cancel", dialog));
    expect(focusOpener()).toBe(publish);
  });

  it("forgets the opener after a press on plain page", () => {
    recordFocusOpener(button("Publish"));
    const pane = document.createElement("div");
    document.body.append(pane);

    recordFocusOpener(pane);
    expect(focusOpener()).toBeNull();
  });

  it("answers null once the opener has left the page", () => {
    const publish = button("Publish");
    recordFocusOpener(publish);
    publish.remove();
    expect(focusOpener()).toBeNull();
  });
});

describe("dialogFinalFocus", () => {
  it("returns the recorded opener", () => {
    const publish = button("Publish");
    recordFocusOpener(publish);
    expect(dialogFinalFocus()).toBe(publish);
  });

  it("leaves focus in another dialog that already holds it", () => {
    recordFocusOpener(button("Publish"));
    const rename = document.createElement("div");
    rename.dataset.slot = "dialog-content";
    document.body.append(rename);
    button("Save", rename).focus();

    expect(dialogFinalFocus()).toBe(false);
  });

  it("returns the opener from the closing dialog itself", () => {
    const publish = button("Publish");
    recordFocusOpener(publish);
    const closing = document.createElement("div");
    closing.dataset.slot = "dialog-content";
    closing.dataset.closed = "";
    document.body.append(closing);
    button("Cancel", closing).focus();

    expect(dialogFinalFocus()).toBe(publish);
  });

  it("falls back to Base UI's own choice with no opener", () => {
    expect(dialogFinalFocus()).toBe(true);
  });
});
