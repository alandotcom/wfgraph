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
  copy: string;
  duplicate: string;
  findStep: string;
  fitView: string;
  group: string;
  paste: string;
  run: string;
  save: string;
  undo: string;
  redo: string;
  palette: string;
};

/** The chords the menu bar prints, spelled for this keyboard. */
export function editorShortcutLabels(onApple: boolean): EditorShortcutLabels {
  return onApple
    ? {
        copy: "⌘C",
        duplicate: "⌘D",
        findStep: "⌘F",
        fitView: "⌘/",
        group: "⌘G",
        paste: "⌘V",
        run: "⌘↵",
        save: "⌘S",
        undo: "⌘Z",
        redo: "⇧⌘Z",
        palette: "⌘K",
      }
    : {
        copy: "Ctrl+C",
        duplicate: "Ctrl+D",
        findStep: "Ctrl+F",
        fitView: "Ctrl+/",
        group: "Ctrl+G",
        paste: "Ctrl+V",
        run: "Ctrl+Enter",
        save: "Ctrl+S",
        undo: "Ctrl+Z",
        redo: "Ctrl+Shift+Z",
        palette: "Ctrl+K",
      };
}

/** The key that opens the shortcut reference from outside a text field. */
export const SHORTCUT_REFERENCE_KEY = "?";

/**
 * The keys that collapse and show the editor's outline and details columns
 * from outside a text field.
 */
export const COLUMN_SHORTCUT_KEYS = { outline: "[", details: "]" } as const;

/** One row of the shortcut reference: what it does, and each key that does it. */
export type ShortcutEntry = {
  readonly label: string;
  /** Alternatives, each drawn as one keycap. */
  readonly keys: readonly string[];
};

export type ShortcutSection = {
  readonly title: string;
  readonly entries: readonly ShortcutEntry[];
};

/**
 * Every shortcut the app binds, grouped by where it works, spelled for this
 * keyboard. A shortcut added anywhere in the client gets a row here, because
 * this list is the only place a person can find it.
 */
export function shortcutReference(
  onApple: boolean
): readonly ShortcutSection[] {
  const keys = editorShortcutLabels(onApple);
  const enter = onApple ? "↵" : "Enter";
  const backspace = onApple ? "⌫" : "Backspace";
  const rowActions = onApple ? "⇧F10" : "Shift+F10";
  return [
    {
      title: "Anywhere",
      entries: [
        { label: "Open the command palette", keys: [keys.palette] },
        { label: "Show keyboard shortcuts", keys: [SHORTCUT_REFERENCE_KEY] },
      ],
    },
    {
      title: "Workflows page",
      entries: [
        { label: "Move to the next row", keys: ["↓", "J"] },
        { label: "Move to the previous row", keys: ["↑", "K"] },
        { label: "Open the row", keys: [enter] },
        { label: "Select the row", keys: ["Space"] },
        { label: "Open the row's actions", keys: [rowActions] },
      ],
    },
    {
      title: "Editor",
      entries: [
        { label: "Save workflow", keys: [keys.save] },
        { label: "Run draft", keys: [keys.run] },
        { label: "Undo", keys: [keys.undo] },
        { label: "Redo", keys: [keys.redo] },
        { label: "Find a step in the outline", keys: [keys.findStep] },
        {
          label: "Collapse or show the outline",
          keys: [COLUMN_SHORTCUT_KEYS.outline],
        },
        {
          label: "Collapse or show details",
          keys: [COLUMN_SHORTCUT_KEYS.details],
        },
        { label: "Go back in details", keys: ["Esc"] },
      ],
    },
    {
      title: "Canvas",
      entries: [
        { label: "Fit view", keys: [keys.fitView] },
        { label: "Copy selection", keys: [keys.copy] },
        { label: "Paste", keys: [keys.paste] },
        { label: "Duplicate selection", keys: [keys.duplicate] },
        { label: "Group selection", keys: [keys.group] },
        { label: "Delete selection", keys: [backspace, "Delete"] },
        { label: "Move the selected steps", keys: ["Arrow keys"] },
      ],
    },
    {
      title: "Dialogs",
      entries: [
        { label: "Run or publish from the dialog", keys: [keys.run] },
        { label: "Close the dialog", keys: ["Esc"] },
      ],
    },
  ];
}
