import { describe, expect, it } from "vitest";
import {
  editorShortcutLabels,
  isApplePlatform,
  SHORTCUT_REFERENCE_KEY,
  shortcutReference,
} from "#src/lib/shortcut-label";

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
      agent: "⌘J",
      copy: "⌘C",
      duplicate: "⌘D",
      findStep: "⌘F",
      fitView: "⌘/",
      group: "⌘G",
      paste: "⌘V",
      run: "⌘↵",
      undo: "⌘Z",
      redo: "⇧⌘Z",
      palette: "⌘K",
    });
    expect(editorShortcutLabels(false)).toEqual({
      agent: "Ctrl+J",
      copy: "Ctrl+C",
      duplicate: "Ctrl+D",
      findStep: "Ctrl+F",
      fitView: "Ctrl+/",
      group: "Ctrl+G",
      paste: "Ctrl+V",
      run: "Ctrl+Enter",
      undo: "Ctrl+Z",
      redo: "Ctrl+Shift+Z",
      palette: "Ctrl+K",
    });
  });
});

describe("shortcutReference", () => {
  it("lists every bound chord in the keyboard's spelling", () => {
    const labels = editorShortcutLabels(false);
    const keys = shortcutReference(false).flatMap((section) =>
      section.entries.flatMap((entry) => entry.keys)
    );
    for (const chord of Object.values(labels)) {
      expect(keys).toContain(chord);
    }
    expect(keys).toContain(SHORTCUT_REFERENCE_KEY);
    expect(keys.some((key) => key.includes("⌘"))).toBe(false);
  });

  it("lists the outline's keys, J and K between runs, and Escape in each place", () => {
    const sections = shortcutReference(false);
    const keysOf = (title: string) =>
      sections
        .find((section) => section.title === title)
        ?.entries.flatMap((entry) => entry.keys) ?? [];

    for (const key of [
      "↓",
      "↑",
      "Home",
      "End",
      "←",
      "→",
      "Space",
      "Enter",
      "/",
      "Alt+↑",
      "Alt+↓",
      "Ctrl+F",
    ]) {
      expect(keysOf("Outline")).toContain(key);
    }
    expect(keysOf("Runs")).toEqual(["J", "K"]);
    // `[` hides and shows the floating outline; nothing collapses details.
    expect(keysOf("Editor")).toContain("[");
    expect(keysOf("Editor")).not.toContain("]");
    const escapes =
      sections
        .find((section) => section.title === "Escape")
        ?.entries.map((entry) => entry.label) ?? [];
    for (const place of [
      "In the Inspector",
      "On the canvas",
      "In the outline filter",
      "In a run's evidence",
      "In the agent's conversation",
      "In the command palette",
    ]) {
      expect(escapes.some((label) => label.startsWith(place))).toBe(true);
    }
  });
});
