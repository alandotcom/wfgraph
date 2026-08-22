---
"@wfgraph/client": patch
---

The editor's mobile sheet is Base UI's Drawer, and `vaul` is gone from the dependency tree.

`vaul` was the last package pulling Radix into an install of Workflow Graph: 64 `@radix-ui`
entries in the lockfile, now zero. Base UI's Drawer covers what it did, and `@base-ui/react`
was already installed for the rest of the editor's primitives.

The parts map one to one except for the frame. `Drawer.Viewport` has no vaul counterpart and
is required: it owns the swipe gesture and the touch scroll lock, so it is now the fixed,
full-screen, bottom-aligned box and the sheet inside it is a laid-out flex item rather than a
fixed one. Its bounds are unchanged at `max-h-[90vh]`, and the sheet is still a bounded flex
column, which is what the node config panel's internal scrollers need.

Base UI animates the sheet from CSS rather than from JS: `data-starting-style` and
`data-ending-style` carry the enter and exit frames, `--drawer-swipe-movement-y` follows the
finger, and `--drawer-swipe-progress` fades the backdrop in step with a drag.

The sheet's bottom inset now works. It was a spacer div classed `h-safe-area-inset-bottom`,
which compiles to nothing under Tailwind v4, and is `pb-[env(safe-area-inset-bottom,0px)]` on
the sheet itself.

Dismissal is unchanged: the close button and the sheet's own dismiss reach `closeAll`, Escape
reaches `pop`, and a press outside the sheet closes it.
