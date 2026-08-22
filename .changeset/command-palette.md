---
"@wfgraph/client": minor
---

⌘K opens a command palette whose first job is adding a step and choosing its type.

The search box slice 3 put in the menu bar was decoration; it is now the palette's trigger and
carries the chord it answers to. ⌘K reaches it from anywhere in the editor, on the capture
phase so a focused canvas field cannot eat the keystroke, and leaves the chord alone while
somebody is typing in a text field. The palette opens at a root page holding "Add step" beside
the Actions menu's own commands, each carrying that menu's disabled rule so a pinned run or a
generation in flight refuses them in both places alike.

"Add step" leads to the node types the extension catalog offers, grouped by category with
System first. They answer to more than their labels: "delay" finds Wait, "branch" finds
Condition, and "race" finds Event Split. Choosing one creates the step, selects it, and opens
its configuration, which is one stage where it used to be two.

The canvas skips the root. "Add Step" in the graph's context menu opens the palette straight on
the node types, carrying the spot that was right-clicked. The Actions menu's own "Add step"
opens the same page and puts the step in the middle of the canvas, moved clear of whatever is
already there.

Escape is contested and the palette wins the first press: it goes back a page while there is
one to go back to, and closes at the root. Backspace on an empty search box does the same. Both
clear what was typed, because a word typed on one page filters the next one to nothing.

Built on Base UI's Autocomplete inside a Dialog, which is the shape their own command-palette
example takes. shadcn's `command` is backed by cmdk, which declares four `@radix-ui/*` packages
this repository has none of.

The palette names itself for a screen reader: the search box, the option list, the page it is
on as a live region, and a close control for a touch reader with no Escape key. It refuses to
open whenever the Actions menu would refuse "Add step" — a run pinned to the canvas, or a
generation rewriting the graph — and says which, rather than swallowing the keystroke. A
non-owner is offered no way into it, opening another workflow throws a held one away, and a
workflow that has not been saved yet has no palette.

The action grid in the config panel now searches and groups node types through the same module
the palette does, so "delay" finds Wait in both. It used to read three fields of its own.
