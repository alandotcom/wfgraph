---
"@wfgraph/core": major
"@wfgraph/client": major
"@wfgraph/shared": major
---

Redesign the editor workspace around Canvas Reveal and generalized Groups

The editor's resizable sidebar is replaced by Canvas Reveal, a panel that floats
over the right side of the canvas in Draft, Runs, and Changes. Browse summarizes
the selected step, Condition, Lifecycle Node, Event Split, Group, run, or change,
and Focus holds its complete editor, a run node's evidence, or its field-level
differences. On a canvas 1024px or wider, a handle on the panel's left edge
resizes Browse and Focus by pointer or keyboard, and the browser remembers each
width. The query string names the open workspace, run, comparison, and Group,
so browser Back and Forward move between them and a copied link reopens the
same view.

A Group can now hold any two or more steps that meet the version 1 Group rules,
including side-effecting actions, Waits, and Conditions. The workflow canvas
shows a Group as one collapsed card with one outlet. The card and summary display
the Group's description, and the context menu's Edit command opens its editing
form directly. Entering a Group opens a
canvas of its members at their stored positions. Members can be dragged, added,
pasted, duplicated, connected, and deleted. Tidy layout arranges the focused
members in one undoable edit without moving outside steps. Add step after
inserts between an outlet and its existing targets; dragging an outlet into
empty canvas creates a branch without an automatic rejoin. Connections that
would create a cycle are refused before saving.
Connecting the card's outlet keeps existing continuation ports or connects from
terminal non-Condition steps. Unused Condition outlets stay unwired, so an unused
branch ends the path without running the step after the Group. Grouping never changes what a run executes. Runs shows a Group's run status and step counts, and Changes
counts Group edits as Organization changes. Publish refuses a Group that breaks
the rules listed in `docs/embedding.md` ("Groups"). A draft save refuses Group
membership errors and edges that touch a Group frame, and a draft that breaks only the Publish rules still saves
and runs. The build agent and MCP authoring keep existing Groups
valid and cannot create a Group or ungroup one.

On a phone, Draft, Runs, and Changes use a sequence of sheets. A Workflow
Builder there can inspect objects and edit the configuration of existing steps,
and cannot add, move, delete, connect, group, or ungroup steps.

A Group's config is now empty. Graph decoding refuses every config key, so a
draft or published version that still stores `direction`, `entryNodeIds`,
`exitNodeIds`, or `outletHandle` in a Group's config fails to load. This
release ships no migration for those keys.
