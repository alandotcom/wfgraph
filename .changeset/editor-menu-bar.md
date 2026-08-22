---
"@wfgraph/client": minor
---

Replace the editor's icon toolbar with two menus on a fixed-height bar.

Nine controls, six of them identical grey squares you had to hover to identify,
become one 44px line: the dashboard, a menu on the workflow's name, an Actions
menu, the command palette's trigger, and Publish with a written label. The
Actions menu names what it does and shows the shortcut each item is bound to,
and the Live/Test pair becomes a single "Switch to <other> mode", since the
status strip already says which mode the workflow is in. The workflow menu adds
Rename and Delete Workflow beside the switcher and prints the workflow's id.

The Save button is gone. Autosave writes the draft, the strip says when it last
landed, and Cmd+S still forces one.

Renaming a workflow now waits on the request rather than on the autosave
debounce, and a name the server refuses is taken back off the editor and out of
the save queue. Left parked, a refused name rode along with every later graph
write and failed it too, so one rejected rename stopped the editor saving
anything for the rest of the session.

"Tidy layout" in the Actions menu and the reflow control at the canvas's bottom
left now run one shared pass, and Add step, Undo, Redo and Tidy layout all
refuse while a past run is pinned to the canvas, which the buttons they replace
did not.
