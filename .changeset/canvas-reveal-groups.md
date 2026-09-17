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
shows a Group as one collapsed card with one outlet, and entering it opens a
canvas of its members laid out top to bottom or left to right, where steps are
added, pasted, duplicated, connected, and deleted as members of that Group.
Connecting the card's outlet to a step outside the Group connects every place a
path ends inside the Group to that step, which then runs once after every
branch. Grouping never changes what a run executes. Runs shows a Group's run status and step counts, and Changes
counts Group edits as Organization changes. Publish refuses a Group that breaks
the rules listed in `docs/embedding.md` ("Groups"). A draft save refuses Group
membership errors and edges that touch a Group frame, and a draft that breaks only the Publish rules still saves
and runs. The build agent and MCP authoring keep existing Groups
valid and cannot create a Group, ungroup one, or change its direction.

On a phone, Draft, Runs, and Changes use a sequence of sheets. A Workflow
Builder there can inspect objects and edit the configuration of existing steps,
and cannot add, move, delete, connect, group, or ungroup steps.

A Group's config now holds only `direction`. Graph decoding refuses any other
key, so a draft or published version that still stores `entryNodeIds`,
`exitNodeIds`, or `outletHandle` in a Group's config fails to load. This
release ships no migration for those keys.
