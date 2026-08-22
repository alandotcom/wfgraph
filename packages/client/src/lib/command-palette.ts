/**
 * The command palette's page stack.
 *
 * Base UI's Autocomplete has no notion of pages, so the two stages the palette
 * needs -- the root, and the node types "Add step" leads to -- are a stack this
 * module owns. Every move through the stack clears the query, because a word
 * typed on one page filters the next one to nothing and leaves the reader
 * looking at an empty palette with no way to see why.
 */

/** Where a new step lands, in canvas coordinates. */
export type CanvasPosition = { readonly x: number; readonly y: number };

/**
 * One page of the palette.
 *
 * `add-step` carries the position the step will be created at when the canvas
 * asked for it, and leaves it out when the menu bar did: the canvas knows where
 * the user pointed, and the menu bar has nothing to say about placement.
 */
export type CommandPalettePage =
  | { readonly id: "root" }
  | { readonly id: "add-step"; readonly at?: CanvasPosition };

export type CommandPaletteState = {
  /**
   * The workflow the palette was opened over. A palette left open across a
   * navigation belongs to the workflow that is gone, not to the one that
   * arrived, and `commandPaletteAtom` reads this to refuse it.
   */
  readonly workflowId: string;
  /** Deepest page last. Never empty; popping the last page closes the palette. */
  readonly pages: readonly [CommandPalettePage, ...CommandPalettePage[]];
  /** What is typed in the search box, on this page only. */
  readonly query: string;
};

export function openPalette(
  workflowId: string,
  page: CommandPalettePage
): CommandPaletteState {
  return { workflowId, pages: [page], query: "" };
}

/** The page the palette is showing. */
export function currentPalettePage(
  state: CommandPaletteState
): CommandPalettePage {
  return state.pages[state.pages.length - 1];
}

/** Whether Escape and Backspace-on-empty have a page to go back to. */
export function paletteCanGoBack(state: CommandPaletteState): boolean {
  return state.pages.length > 1;
}

export function pushPalettePage(
  state: CommandPaletteState,
  page: CommandPalettePage
): CommandPaletteState {
  return { ...state, pages: [...state.pages, page], query: "" };
}

/** The state after going back one page, or null when that closes the palette. */
export function popPalettePage(
  state: CommandPaletteState
): CommandPaletteState | null {
  if (!paletteCanGoBack(state)) {
    return null;
  }
  const [first, ...rest] = state.pages.slice(0, -1);
  if (!first) {
    return null;
  }
  return { ...state, pages: [first, ...rest], query: "" };
}

export function setPaletteQuery(
  state: CommandPaletteState,
  query: string
): CommandPaletteState {
  return { ...state, query };
}
