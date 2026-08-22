import { describe, expect, it } from "vitest";
import { editorShortcutLabels, isApplePlatform } from "#src/lib/shortcut-label";

describe("isApplePlatform", () => {
  it("reads the platforms whose modifier is Command", () => {
    expect(isApplePlatform("MacIntel")).toBe(true);
    expect(isApplePlatform("macOS")).toBe(true);
    expect(isApplePlatform("iPhone")).toBe(true);
  });

  it("reads everything else as Control", () => {
    expect(isApplePlatform("Win32")).toBe(false);
    expect(isApplePlatform("Linux x86_64")).toBe(false);
    // Nothing answered, so the safer half of the guess: a chord written with
    // Ctrl is at worst unfamiliar, where ⌘ names a key that is not there.
    expect(isApplePlatform("")).toBe(false);
  });
});

describe("editorShortcutLabels", () => {
  it("spells each chord for the keyboard it will be read on", () => {
    expect(editorShortcutLabels(true)).toEqual({
      run: "⌘↵",
      undo: "⌘Z",
      redo: "⇧⌘Z",
      palette: "⌘K",
    });
    expect(editorShortcutLabels(false)).toEqual({
      run: "Ctrl+Enter",
      undo: "Ctrl+Z",
      redo: "Ctrl+Shift+Z",
      palette: "Ctrl+K",
    });
  });
});
