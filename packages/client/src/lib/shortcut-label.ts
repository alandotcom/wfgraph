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
  /** Hides the build agent's box on the canvas, or shows it again. */
  agent: string;
  copy: string;
  duplicate: string;
  findStep: string;
  fitView: string;
  group: string;
  paste: string;
  run: string;
  undo: string;
  redo: string;
  palette: string;
};

/** The chords the menu bar prints, spelled for this keyboard. */
export function editorShortcutLabels(onApple: boolean): EditorShortcutLabels {
  return onApple
    ? {
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
      }
    : {
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
      };
}

/** The key that opens the shortcut reference from outside a text field. */
export const SHORTCUT_REFERENCE_KEY = "?";

/**
 * The key that hides and shows the outline floating over the canvas, from
 * outside a text field.
 */
export const OUTLINE_SHORTCUT_KEY = "[";

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
  const alt = onApple ? "⌥" : "Alt+";
  return [
    {
      title: "Anywhere",
      entries: [
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
        {
          label: "Open the row's actions, such as showing its failed runs",
          keys: [rowActions],
        },
      ],
    },
    {
      title: "Editor",
      entries: [
        { label: "Open the command palette", keys: [keys.palette] },
        { label: "Run draft", keys: [keys.run] },
        { label: "Undo", keys: [keys.undo] },
        { label: "Redo", keys: [keys.redo] },
        { label: "Hide or show the outline", keys: [OUTLINE_SHORTCUT_KEY] },
        { label: "Hide or show the agent", keys: [keys.agent] },
        { label: "Send a message to the agent", keys: [enter] },
      ],
    },
    {
      title: "Outline",
      entries: [
        { label: "Move to the next or previous row", keys: ["↓", "↑"] },
        { label: "Move to the first or last row", keys: ["Home", "End"] },
        { label: "Fold a section, or move to the parent row", keys: ["←"] },
        { label: "Unfold a section, or move into it", keys: ["→"] },
        { label: "Select the row's step", keys: ["Space"] },
        {
          label: "Select the step and put the cursor in its first field",
          keys: [enter],
        },
        { label: "Add a step after the row's step", keys: ["/"] },
        {
          label: "Move the step up or down its sequence",
          keys: [`${alt}↑`, `${alt}↓`],
        },
        { label: "Filter the steps", keys: [keys.findStep] },
      ],
    },
    {
      title: "Runs",
      entries: [
        { label: "Open the next, older run", keys: ["J"] },
        { label: "Open the previous, newer run", keys: ["K"] },
      ],
    },
    {
      title: "Escape",
      entries: [
        {
          label:
            "In the Inspector: close what is open, go back, then close it and return to the step's outline row",
          keys: ["Esc"],
        },
        {
          label: "On the canvas: clear the selection, keeping your place",
          keys: ["Esc"],
        },
        {
          label: "In the outline filter: clear it, then return to the rows",
          keys: ["Esc"],
        },
        { label: "In a run's evidence: go back to the run", keys: ["Esc"] },
        { label: "In the agent's conversation: collapse it", keys: ["Esc"] },
        {
          label: "In the command palette: go back a page, then close",
          keys: ["Esc"],
        },
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
