/**
 * How the editor's chords are written on the keyboard in front of the reader.
 *
 * Every shortcut behind them takes either modifier (`event.metaKey ||
 * event.ctrlKey`), so a menu that always prints ⌘ names a key most Windows and
 * Linux keyboards do not have. The platform read is deliberately crude: it
 * decides typography, and the shortcut itself works either way.
 */

const APPLE_PLATFORM = /mac|iphone|ipad|ipod/i;

/** Whether this machine's modifier is ⌘. Takes the string so it can be tested. */
export function isApplePlatform(platform: string): boolean {
  return APPLE_PLATFORM.test(platform);
}

/** What the browser says it is running on, or "" where nothing answers. */
export function currentPlatform(): string {
  if (typeof navigator === "undefined") {
    return "";
  }
  // `userAgentData` is Chromium-only and `platform` is deprecated everywhere,
  // so this reads whichever answers and treats neither as required.
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.platform;
  return platform || navigator.userAgent || "";
}

export type EditorShortcutLabels = {
  run: string;
  undo: string;
  redo: string;
};

/** The three chords the Actions menu prints, spelled for this keyboard. */
export function editorShortcutLabels(onApple: boolean): EditorShortcutLabels {
  return onApple
    ? { run: "⌘↵", undo: "⌘Z", redo: "⇧⌘Z" }
    : { run: "Ctrl+Enter", undo: "Ctrl+Z", redo: "Ctrl+Shift+Z" };
}
