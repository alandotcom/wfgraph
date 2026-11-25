/**
 * Whether the keyboard shortcut reference is open. App-wide, because the
 * reference opens from the workflows page, the editor's menus, the command
 * palette, and the "?" key alike.
 */

import { atom } from "jotai";

export const shortcutReferenceOpenAtom = atom(false);
