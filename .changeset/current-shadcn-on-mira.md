---
"@wfgraph/client": minor
---

The editor's primitives are current shadcn, in the `mira` style.

`components.json` moves into `packages/client`, where its `#src/*` aliases resolve; from the
repository root the CLI could not read them at all. Its `style` becomes `base-mira`, which now
names both the primitive family and the visual style, and `rsc` becomes false for a Vite SPA.
Sixteen registry components are re-pulled at that style, bringing `textarea` and `input-group`
with them, and `shadcn/tailwind.css` is imported for the nine `data-*` variants their state
styling compiles against.

`mira` is a dense style: a default button is 28px against the previous 36px, and body text
12px against 14px. Every control in the editor and the dashboard is smaller. The canvas is
untouched, node geometry included.

Three behaviours moved with the primitives. `whenChosen` and the label lookup that renders a
chosen item in a Select trigger are now `#src/lib/select-choice`, outside the file the CLI
overwrites, and the Select root feeds Base UI's own `items` prop. `ComboboxInputGroup` and
`ComboboxClear` are gone, absorbed into `ComboboxInput` behind `showTrigger` and `showClear`,
which takes a `triggerLabel` so the button it renders has an accessible name. `Radio` is
`RadioGroupItem` and `ComboboxGroupLabel` is `ComboboxLabel`.

Two defects fixed on the way. A Select trigger rendered a stray `▼` inside its chevron, because
Base UI's `Select.Icon` defaults its children to that glyph and the registry component passes
only `render`. And the dashboard's mode badge was `text-zinc-700` with no dark counterpart, so
it was unreadable against a dark row.
